import { prisma } from '@/lib/prisma'
import { getMovieDetails, getMovieCredits } from '@/lib/tmdb'
import { cronLogger } from '@/lib/logger'

export const maxDuration = 300

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

async function fetchTMDBPage(endpoint: string, page: number): Promise<{ id: number }[]> {
  const url = `${TMDB_BASE_URL}${endpoint}?page=${page}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
  })
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

    // Fetch now_playing (pages 1–3) for "In Theaters" tracking
    const nowPlayingPages = await Promise.all([
      fetchTMDBPage('/movie/now_playing', 1),
      fetchTMDBPage('/movie/now_playing', 2),
      fetchTMDBPage('/movie/now_playing', 3),
    ])
    const nowPlayingIds = new Set<number>()
    for (const page of nowPlayingPages) {
      for (const movie of page) {
        nowPlayingIds.add(movie.id)
      }
    }

    // Fetch upcoming (pages 1–3) for new imports
    const upcomingPages = await Promise.all([
      fetchTMDBPage('/movie/upcoming', 1),
      fetchTMDBPage('/movie/upcoming', 2),
      fetchTMDBPage('/movie/upcoming', 3),
    ])

    // All candidate TMDB IDs (de-duped)
    const allIds = new Set<number>(nowPlayingIds)
    for (const page of upcomingPages) {
      for (const movie of page) {
        allIds.add(movie.id)
      }
    }

    cronLogger.info({ nowPlayingCount: nowPlayingIds.size, totalCandidates: allIds.size }, 'TMDB candidates fetched')

    // --- Refresh nowPlaying flags ---
    // Set nowPlaying=false for all films not in the current now_playing list
    await prisma.film.updateMany({
      where: { nowPlaying: true, tmdbId: { notIn: Array.from(nowPlayingIds) } },
      data: { nowPlaying: false },
    })
    // Set nowPlaying=true for films that ARE in the current now_playing list
    if (nowPlayingIds.size > 0) {
      await prisma.film.updateMany({
        where: { tmdbId: { in: Array.from(nowPlayingIds) } },
        data: { nowPlaying: true },
      })
    }
    cronLogger.info({ nowPlayingIds: nowPlayingIds.size }, 'nowPlaying flags refreshed')

    // --- Import new films ---
    const existing = await prisma.film.findMany({
      where: { tmdbId: { in: Array.from(allIds) } },
      select: { tmdbId: true },
    })
    const existingSet = new Set(existing.map((f) => f.tmdbId))
    const newTmdbIds = Array.from(allIds).filter((id) => !existingSet.has(id))

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
            nowPlaying: nowPlayingIds.has(movie.id),
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
    cronLogger.info({ imported, skipped, failed, durationMs }, 'Weekly import complete')

    return Response.json({ imported, skipped, failed, nowPlayingRefreshed: nowPlayingIds.size, durationMs })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    cronLogger.error({ error: message, durationMs: Date.now() - startTime }, 'Import cron failed')
    return Response.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
