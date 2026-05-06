/**
 * GET /api/films/<filmId>/backdrops
 *
 * Returns the filtered + sorted + capped list of TMDB backdrops for the
 * banner picker (PR 1c). Auth-less, mirrors /api/films and /api/films/[id].
 *
 * Filtering:
 *   - width >= 1280 (drops thumbnails and odd small uploads)
 *   - iso_639_1 IS NULL strictly (clean cinematography stills, no
 *     text/title cards in any language)
 * Sort: vote_count DESC, vote_average DESC as tiebreaker. Volume before
 * rating prevents single-vote outliers ranking above well-voted backdrops.
 * Cap: 20 results.
 *
 * Caching: filtered/sorted/capped projection is cached at
 * tmdb:backdrops:<filmId> for 7 days, keyed on the internal Cinemagraphs
 * filmId so we can invalidate by our own id. The raw TMDB images
 * response continues to be cached at tmdb:images:<tmdbId> via
 * getMovieImages — these are two intentional cache layers.
 *
 * TODO(PR 1c followup): add stale-while-revalidate at the Redis layer
 * if cache stampede on a popular film at first-miss becomes a real
 * issue. v1 ships plain TTL because the inline SWR implementation
 * is non-trivial for one route's worth of value.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { cachedQuery, KEYS, TTL } from '@/lib/cache'
import { getMovieImages } from '@/lib/tmdb'

const MIN_WIDTH = 1280
const MAX_RESULTS = 20

interface BackdropProjection {
  file_path: string
  width: number
  height: number
  vote_count: number
  vote_average: number
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const film = await prisma.film.findUnique({
      where: { id },
      select: { id: true, tmdbId: true },
    })

    if (!film) {
      return Response.json({ error: 'Film not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    const cacheKey = KEYS.tmdbBackdrops(film.id)

    try {
      const backdrops = await cachedQuery<BackdropProjection[]>(
        cacheKey,
        TTL.TMDB_IMAGES,
        async () => {
          const data = await getMovieImages(film.tmdbId)
          return data.backdrops
            .filter((b) => b.width >= MIN_WIDTH && b.iso_639_1 === null)
            .sort(
              (a, b) =>
                b.vote_count - a.vote_count || b.vote_average - a.vote_average
            )
            .slice(0, MAX_RESULTS)
            .map((b) => ({
              file_path: b.file_path,
              width: b.width,
              height: b.height,
              vote_count: b.vote_count,
              vote_average: b.vote_average,
            }))
        }
      )
      return Response.json({ backdrops })
    } catch (tmdbErr) {
      // TMDB API failure (5xx, timeout, network). Fail open with empty
      // array so mobile can fall back to the Film's default backdropUrl.
      // Empty result is NOT cached because the throw escapes cachedQuery's
      // fetchFn, so cacheSet never fires.
      apiLogger.error(
        { err: tmdbErr, filmId: film.id, tmdbId: film.tmdbId },
        'TMDB backdrops fetch failed, returning empty array'
      )
      return Response.json({ backdrops: [] })
    }
  } catch (err) {
    apiLogger.error({ err, filmId: id }, 'Failed to fetch backdrops')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
