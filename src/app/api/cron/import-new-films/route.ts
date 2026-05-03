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

// TMDB now_playing is region-scoped; sampling both primary English-language
// markets avoids single-region bleed-in of regional theatrical releases.
const NOW_PLAYING_REGIONS = ['CA', 'US'] as const

async function fetchTMDBPage(
  endpoint: string,
  page: number,
  region?: string
): Promise<{ id: number }[]> {
  const params = new URLSearchParams({ page: String(page) })
  if (region) params.set('region', region)
  const url = `${TMDB_BASE_URL}${endpoint}?${params.toString()}`
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

    // Fetch now_playing (pages 1-3 × regions CA, US) for "In Theaters" tracking
    const nowPlayingPages = await Promise.all(
      NOW_PLAYING_REGIONS.flatMap((region) => [
        fetchTMDBPage('/movie/now_playing', 1, region),
        fetchTMDBPage('/movie/now_playing', 2, region),
        fetchTMDBPage('/movie/now_playing', 3, region),
      ])
    )
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

    cronLogger.info(
      {
        nowPlayingCount: nowPlayingIds.size,
        regions: [...NOW_PLAYING_REGIONS],
        totalCandidates: allIds.size,
      },
      'TMDB candidates fetched'
    )

    // --- Refresh nowPlaying flags (respecting admin overrides) ---
    // Only auto-update films with NO override (nowPlayingOverride is null)
    await prisma.film.updateMany({
      where: { nowPlaying: true, nowPlayingOverride: null, tmdbId: { notIn: Array.from(nowPlayingIds) } },
      data: { nowPlaying: false },
    })
    // Capture films about to flip false→true via the auto-managed branch
    // BEFORE we run the updateMany — afterwards we can't distinguish them
    // from films that were already nowPlaying=true from a prior run.
    // We only handle the auto-managed (override=null) branch here; force_show
    // films are admin-curated and the analyze cron's first-priority queue
    // (graphless films) will pick them up on the next tick.
    const flippedAndGraphless: { id: string; title: string; tmdbId: number }[] = []
    if (nowPlayingIds.size > 0) {
      const willFlip = await prisma.film.findMany({
        where: {
          nowPlaying: false,
          nowPlayingOverride: null,
          tmdbId: { in: Array.from(nowPlayingIds) },
        },
        select: {
          id: true,
          title: true,
          tmdbId: true,
          sentimentGraph: { select: { id: true } },
        },
      })
      for (const f of willFlip) {
        if (!f.sentimentGraph) {
          flippedAndGraphless.push({ id: f.id, title: f.title, tmdbId: f.tmdbId })
        }
      }
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

    // Generate sentiment graphs for newly-flipped films that lack one.
    // Mirrors the import-time auto-generate path's call shape (sequential
    // synchronous Messages API; no parallelism). On a busy release weekend
    // this can compound with new-import generation and exceed Vercel's
    // maxDuration; films past the cutoff fall through to the next analyze
    // cron tick, which now prioritizes graphless films first (Stage B).
    for (const film of flippedAndGraphless) {
      try {
        await generateSentimentGraph(film.id, { callerPath: 'cron-analyze' })
        await invalidateFilmCache(film.id)
        cronLogger.info(
          { tmdbId: film.tmdbId, title: film.title },
          'Sentiment graph generated for newly-flipped film'
        )
      } catch (sentErr) {
        const sentMsg = sentErr instanceof Error ? sentErr.message : 'Unknown error'
        cronLogger.error(
          { tmdbId: film.tmdbId, title: film.title, error: sentMsg },
          'Failed to generate sentiment graph for newly-flipped film'
        )
      }
    }

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
            await generateSentimentGraph(createdFilm.id, { callerPath: 'cron-analyze' })
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

    // Health check: detect if the search vector trigger has been dropped.
    // If any ACTIVE film has a NULL searchVector, new films won't appear
    // in search. This is silent degradation; log loudly so we catch it.
    try {
      const result = await prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint as count
        FROM "Film"
        WHERE status = 'ACTIVE' AND "searchVector" IS NULL
      `
      const nullVectorCount = Number(result[0]?.count ?? 0)
      if (nullVectorCount > 0) {
        cronLogger.error(
          { nullVectorCount },
          'Film.searchVector NULL on active rows. Search trigger may be dropped. Recovery: re-run trigger SQL from migration add_film_search_vector and UPDATE "Film" SET title = title WHERE "searchVector" IS NULL.',
        )
      }
    } catch (healthErr) {
      cronLogger.error(
        { err: healthErr instanceof Error ? healthErr.message : 'Unknown' },
        'Failed to run searchVector health check',
      )
    }

    return Response.json({ imported, skipped: skipCounts.total, skipCounts, failed, nowPlayingRefreshed: nowPlayingIds.size, durationMs })
  } catch (err) {
    cronLogger.error({ err, durationMs: Date.now() - startTime }, 'Import cron failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
