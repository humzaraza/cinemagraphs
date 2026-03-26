import { prisma } from '@/lib/prisma'
import { cronLogger } from '@/lib/logger'

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
      include: { sentimentGraph: { select: { id: true, overallScore: true } } },
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

        // Save current imdbRating as previous, update with new
        const currentRating = film.imdbRating
        await prisma.film.update({
          where: { id: film.id },
          data: { imdbRating: newRating },
        })

        // Also update previousScore on the sentiment graph so ticker delta works
        if (film.sentimentGraph && currentRating != null && Math.abs(newRating - currentRating) > 0.01) {
          await prisma.sentimentGraph.update({
            where: { id: film.sentimentGraph.id },
            data: { previousScore: film.sentimentGraph.overallScore },
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
    const message = err instanceof Error ? err.message : 'Unknown error'
    cronLogger.error({ error: message, durationMs: Date.now() - startTime }, 'Score refresh cron failed')
    return Response.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
