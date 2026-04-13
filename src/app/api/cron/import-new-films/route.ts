import { prisma } from '@/lib/prisma'
import { getMovieDetails, getMovieCredits } from '@/lib/tmdb'
import { syncFilmCredits } from '@/lib/person-sync'
import { cronLogger } from '@/lib/logger'
import { invalidateHomepageCache, invalidateFilmCache } from '@/lib/cache'
import { generateSentimentGraph } from '@/lib/sentiment-pipeline'
import { generateAndStoreWikiBeats } from '@/lib/wiki-beat-fallback'
import { checkCronQualityGates, type CronSkipCounts } from '@/lib/cron-quality-gates'

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

    // Fetch now_playing (pages 1-3) for "In Theaters" tracking
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

    // Fetch upcoming (pages 1-3) for new imports
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

    // --- Refresh nowPlaying flags (respecting admin overrides) ---
    // Only auto-update films with NO override (nowPlayingOverride is null)
    await prisma.film.updateMany({
      where: { nowPlaying: true, nowPlayingOverride: null, tmdbId: { notIn: Array.from(nowPlayingIds) } },
      data: { nowPlaying: false },
    })
    if (nowPlayingIds.size > 0) {
      await prisma.film.updateMany({
        where: { nowPlayingOverride: null, tmdbId: { in: Array.from(nowPlayingIds) } },
        data: { nowPlaying: true },
      })
    }
    // Enforce overrides: force_show -> nowPlaying=true, force_hide -> nowPlaying=false
    await prisma.film.updateMany({
      where: { nowPlayingOverride: 'force_show', nowPlaying: false },
      data: { nowPlaying: true },
    })
    await prisma.film.updateMany({
      where: { nowPlayingOverride: 'force_hide', nowPlaying: true },
      data: { nowPlaying: false },
    })
    cronLogger.info({ nowPlayingIds: nowPlayingIds.size }, 'nowPlaying flags refreshed (overrides respected)')

    await invalidateHomepageCache()

    // --- Import new films ---
    const existing = await prisma.film.findMany({
      where: { tmdbId: { in: Array.from(allIds) } },
      select: { tmdbId: true },
    })
    const existingSet = new Set(existing.map((f) => f.tmdbId))
    const newTmdbIds = Array.from(allIds).filter((id) => !existingSet.has(id))

    cronLogger.info({ newCount: newTmdbIds.length, skippedExisting: existingSet.size }, 'After de-duplication')

    let imported = 0
    let failed = 0
    const skipCounts: CronSkipCounts = {
      total: 0,
      lowVotes: 0,
      lowPopularity: 0,
      excludedGenre: 0,
      noPoster: 0,
      shortRuntime: 0,
      noOverview: 0,
    }

    for (const tmdbId of newTmdbIds) {
      try {
        const [movie, credits] = await Promise.all([
          getMovieDetails(tmdbId),
          getMovieCredits(tmdbId),
        ])

        const gateResult = checkCronQualityGates(movie)
        if (!gateResult.pass) {
          skipCounts.total++
          skipCounts[gateResult.reason]++
          cronLogger.info({ tmdbId, title: movie.title, reason: gateResult.reason }, 'Film skipped by quality gate')
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

        const createdFilm = await prisma.film.create({
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

        // Sync Person/FilmPerson records from credits
        try {
          await syncFilmCredits(createdFilm.id, movie.id)
        } catch (syncErr) {
          cronLogger.error({ tmdbId, error: syncErr instanceof Error ? syncErr.message : 'Unknown' }, 'Failed to sync credits')
        }

        imported++
        cronLogger.info({ tmdbId, title: movie.title }, 'Film imported')

        // Auto-generate sentiment graph for now_playing films
        if (nowPlayingIds.has(movie.id)) {
          try {
            await generateSentimentGraph(createdFilm.id)
            await invalidateFilmCache(createdFilm.id)
            cronLogger.info({ tmdbId, title: movie.title }, 'Sentiment graph generated for new now_playing film')
          } catch (sentErr) {
            const sentMsg = sentErr instanceof Error ? sentErr.message : 'Unknown error'
            cronLogger.error({ tmdbId, title: movie.title, error: sentMsg }, 'Failed to generate sentiment graph for new film')
          }
        }

        // For every newly imported film (now_playing or upcoming), generate Wikipedia
        // story beats so users can rate the film even without an NLP sentiment graph.
        // Respects existing SentimentGraph/FilmBeats (no overwrites).
        try {
          const beatResult = await generateAndStoreWikiBeats(createdFilm.id)
          if (beatResult.status === 'generated') {
            cronLogger.info(
              { tmdbId, title: movie.title, beatCount: beatResult.beatCount },
              'Wikipedia beats generated for new film'
            )
          }
        } catch (beatErr) {
          const beatMsg = beatErr instanceof Error ? beatErr.message : 'Unknown error'
          cronLogger.error({ tmdbId, title: movie.title, error: beatMsg }, 'Failed to generate wiki beats for new film')
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        cronLogger.error({ tmdbId, error: message }, 'Failed to import film')
        failed++
      }
    }

    const durationMs = Date.now() - startTime
    cronLogger.info(
      { imported, skipped: skipCounts.total, failed, skipCounts, durationMs },
      `TMDB sync complete: ${imported} films added, ${skipCounts.total} films skipped (${skipCounts.lowVotes} low votes, ${skipCounts.lowPopularity} low popularity, ${skipCounts.excludedGenre} excluded genre)`
    )

    return Response.json({ imported, skipped: skipCounts.total, skipCounts, failed, nowPlayingRefreshed: nowPlayingIds.size, durationMs })
  } catch (err) {
    cronLogger.error({ err, durationMs: Date.now() - startTime }, 'Import cron failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
