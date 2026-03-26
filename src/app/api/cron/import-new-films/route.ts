import { prisma } from '@/lib/prisma'
import { getMovieDetails, getMovieCredits } from '@/lib/tmdb'
import { cronLogger } from '@/lib/logger'

export const maxDuration = 300

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

async function fetchTMDBPage(endpoint: string, page: number): Promise<{ id: number }[]> {
  const url = `${TMDB_BASE_URL}${endpoint}?api_key=${TMDB_API_KEY}&page=${page}`
  const res = await fetch(url)
  if (!res.ok) return []
  const data = await res.json()
  return data.results ?? []
}

export async function GET(request: Request) {
  const startTime = Date.now()

  try {
    const authHeader = request.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
    }

    // Fetch from now_playing and upcoming (pages 1–3 each)
    const pages = await Promise.all([
      fetchTMDBPage('/movie/now_playing', 1),
      fetchTMDBPage('/movie/now_playing', 2),
      fetchTMDBPage('/movie/now_playing', 3),
      fetchTMDBPage('/movie/upcoming', 1),
      fetchTMDBPage('/movie/upcoming', 2),
      fetchTMDBPage('/movie/upcoming', 3),
    ])

    // De-duplicate by TMDB ID
    const seen = new Set<number>()
    const tmdbIds: number[] = []
    for (const page of pages) {
      for (const movie of page) {
        if (!seen.has(movie.id)) {
          seen.add(movie.id)
          tmdbIds.push(movie.id)
        }
      }
    }

    cronLogger.info({ candidateCount: tmdbIds.length }, 'TMDB candidates fetched')

    // Filter out films already in the database
    const existing = await prisma.film.findMany({
      where: { tmdbId: { in: tmdbIds } },
      select: { tmdbId: true },
    })
    const existingSet = new Set(existing.map((f) => f.tmdbId))
    const newTmdbIds = tmdbIds.filter((id) => !existingSet.has(id))

    cronLogger.info({ newCount: newTmdbIds.length, skippedExisting: existingSet.size }, 'After de-duplication')

    let imported = 0
    let skipped = 0
    let failed = 0

    for (const tmdbId of newTmdbIds) {
      try {
        const [movie, credits] = await Promise.all([
          getMovieDetails(tmdbId),
          getMovieCredits(tmdbId),
        ])

        // Filter: must have poster, runtime > 60, and overview
        if (!movie.poster_path || !movie.runtime || movie.runtime <= 60 || !movie.overview) {
          skipped++
          continue
        }

        const director = credits.crew.find((c) => c.job === 'Director')?.name ?? null
        const topCast = credits.cast
          .sort((a, b) => a.order - b.order)
          .slice(0, 10)
          .map((c) => ({
            name: c.name,
            character: c.character,
            profilePath: c.profile_path,
          }))

        await prisma.film.create({
          data: {
            tmdbId: movie.id,
            imdbId: movie.imdb_id ?? null,
            title: movie.title,
            releaseDate: movie.release_date ? new Date(movie.release_date) : null,
            runtime: movie.runtime,
            synopsis: movie.overview,
            posterUrl: movie.poster_path,
            backdropUrl: movie.backdrop_path ?? null,
            genres: movie.genres?.map((g) => g.name) ?? [],
            director,
            cast: topCast,
            imdbRating: movie.vote_average ?? null,
            imdbVotes: movie.vote_count ?? null,
          },
        })

        imported++
        cronLogger.info({ tmdbId, title: movie.title }, 'Film imported')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        cronLogger.error({ tmdbId, error: message }, 'Failed to import film')
        failed++
      }
    }

    const durationMs = Date.now() - startTime
    cronLogger.info({ imported, skipped, failed, durationMs }, 'Monthly import complete')

    return Response.json({ imported, skipped, failed, durationMs })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    cronLogger.error({ error: message, durationMs: Date.now() - startTime }, 'Import cron failed')
    return Response.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
