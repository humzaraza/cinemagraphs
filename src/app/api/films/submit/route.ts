import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser, checkSuspension } from '@/lib/middleware'
import { importMovie } from '@/lib/tmdb'
import { generateSentimentGraph } from '@/lib/sentiment-pipeline'
import { invalidateHomepageCache } from '@/lib/cache'
import { apiLogger } from '@/lib/logger'

const RATE_LIMIT_MS = 5 * 60 * 60 * 1000 // 5 hours

export async function POST(request: NextRequest) {
  // Auth check
  const auth = await requireUser()
  if (!auth.authorized) return auth.errorResponse!

  const userId = (auth.session as any).user.id as string

  // Suspension check
  const suspended = await checkSuspension(userId)
  if (suspended) return suspended

  try {
    const body = await request.json()
    const tmdbId = body.tmdbId

    if (!tmdbId || typeof tmdbId !== 'number' || tmdbId <= 0) {
      return Response.json({ error: 'Valid tmdbId is required' }, { status: 400 })
    }

    // Deduplication check
    const existing = await prisma.film.findUnique({
      where: { tmdbId },
      select: { id: true, title: true },
    })
    if (existing) {
      return Response.json({
        film: existing,
        alreadyExists: true,
        message: 'This film is already on Cinemagraphs',
      })
    }

    // Rate limiting check
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { lastFilmAddedAt: true },
    })

    if (user?.lastFilmAddedAt) {
      const elapsed = Date.now() - new Date(user.lastFilmAddedAt).getTime()
      if (elapsed < RATE_LIMIT_MS) {
        const retryAfterMs = RATE_LIMIT_MS - elapsed
        const hours = Math.floor(retryAfterMs / (60 * 60 * 1000))
        const minutes = Math.ceil((retryAfterMs % (60 * 60 * 1000)) / (60 * 1000))
        return Response.json(
          {
            error: `You can add another film in ${hours}h ${minutes}m`,
            code: 'RATE_LIMITED',
            retryAfterMs,
          },
          { status: 429 }
        )
      }
    }

    // Import film from TMDB
    const film = await importMovie(tmdbId)

    // Set addedByUserId and update user's lastFilmAddedAt
    await Promise.all([
      prisma.film.update({
        where: { id: film.id },
        data: { addedByUserId: userId },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { lastFilmAddedAt: new Date() },
      }),
    ])

    // Fire-and-forget: generate sentiment graph
    generateSentimentGraph(film.id)
      .then(() => invalidateHomepageCache())
      .catch((err) => apiLogger.error({ err, filmId: film.id }, 'Failed to generate sentiment graph for user-submitted film'))

    return Response.json({
      film: { id: film.id, title: film.title },
      created: true,
      message: 'Film added! The sentiment graph is being generated and will be ready shortly.',
    })
  } catch (err) {
    apiLogger.error({ err }, 'Film submission failed')
    return Response.json({ error: 'Failed to add film. Please try again.' }, { status: 500 })
  }
}
