import { prisma } from '@/lib/prisma'
import { cronLogger } from '@/lib/logger'
import { safeWriteSentimentGraph } from '@/lib/sentiment-beat-lock'
import type { SentimentDataPoint } from '@/lib/types'

export const maxDuration = 300

const TMDB_API_KEY = process.env.TMDB_API_KEY!

async function fetchOMDBRating(imdbId: string): Promise<number | null> {
  const omdbKey = process.env.OMDB_API_KEY
  if (!omdbKey) return null
  try {
    const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbKey}`)
    if (!res.ok) return null
    const data = await res.json()
    const rating = parseFloat(data.imdbRating)
    return isNaN(rating) ? null : rating
  } catch {
    return null
  }
}

async function fetchTMDBRating(tmdbId: number): Promise<number | null> {
  try {
    const res = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}`, {
      headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.vote_average ?? null
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  const startTime = Date.now()

  try {
    const authHeader = request.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
    }

    // Only refresh scores for now playing films with sentiment graphs
    const films = await prisma.film.findMany({
      where: { nowPlaying: true, sentimentGraph: { isNot: null } },
      include: {
        sentimentGraph: {
          select: { id: true, overallScore: true, varianceSource: true, dataPoints: true },
        },
      },
    })

    cronLogger.info({ filmCount: films.length }, 'Starting daily score refresh for now playing films')

    let updated = 0
    let skipped = 0

    for (const film of films) {
      try {
        // Try OMDB first, fall back to TMDB rating
        let newRating: number | null = null
        if (film.imdbId) {
          newRating = await fetchOMDBRating(film.imdbId)
        }
        if (newRating == null) {
          newRating = await fetchTMDBRating(film.tmdbId)
        }

        if (newRating == null) {
          skipped++
          continue
        }

        // Refresh the stored imdbRating with the freshly fetched value
        const currentRating = film.imdbRating
        await prisma.film.update({
          where: { id: film.id },
          data: { imdbRating: newRating },
        })

        // Re-anchor the Cinemagraphs score to a real external-rating move:
        // shift overallScore by the same amount the external rating moved and
        // capture the old value into previousScore, so the ticker shows a
        // genuine delta. The sentiment-graph beats are left completely untouched
        // (no LLM, no regen). External-only films only; blended films are
        // skipped here and pick up their score change on their next real
        // blend/regen, because their score mixes user/reaction signal that an
        // external-rating shift must not overcount. Sub-0.1 moves are ignored as
        // noise, and we intentionally do NOT stamp previousScore for them so an
        // earlier real delta survives.
        const graph = film.sentimentGraph
        const ratingDelta = currentRating != null ? newRating - currentRating : 0
        if (
          graph &&
          Math.abs(ratingDelta) >= 0.1 &&
          graph.varianceSource === 'external_only'
        ) {
          const shifted = Math.round((graph.overallScore + ratingDelta) * 10) / 10
          const nextOverall = Math.max(1, Math.min(10, shifted))
          await safeWriteSentimentGraph({
            filmId: film.id,
            incomingDataPoints: graph.dataPoints as unknown as SentimentDataPoint[],
            otherFields: {
              previousScore: graph.overallScore,
              overallScore: nextOverall,
            },
            callerPath: 'cron-refresh-scores',
          })
        }

        updated++
        cronLogger.info({ filmId: film.id, title: film.title, oldRating: currentRating, newRating }, 'Score refreshed')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        cronLogger.error({ filmId: film.id, error: message }, 'Failed to refresh score')
        skipped++
      }
    }

    const durationMs = Date.now() - startTime
    cronLogger.info({ updated, skipped, durationMs }, 'Daily score refresh complete')

    return Response.json({ updated, skipped, durationMs })
  } catch (err) {
    cronLogger.error({ err, durationMs: Date.now() - startTime }, 'Score refresh cron failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
