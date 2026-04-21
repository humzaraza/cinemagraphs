import { NextRequest } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { getMovieBackdropUrls } from '@/lib/tmdb'
import type { SentimentDataPoint } from '@/lib/types'
import type { Beat } from '@/lib/carousel/slot-selection'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const auth = await requireRole('ADMIN')
  if (!auth.authorized) return auth.errorResponse!

  let body: { filmId?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const filmId = typeof body.filmId === 'string' ? body.filmId : null
  if (!filmId) {
    return Response.json({ error: 'filmId is required' }, { status: 400 })
  }

  const film = await prisma.film.findUnique({
    where: { id: filmId },
    select: {
      id: true,
      tmdbId: true,
      title: true,
      releaseDate: true,
      runtime: true,
      genres: true,
      sentimentGraph: {
        select: { overallScore: true, dataPoints: true },
      },
    },
  })

  if (!film) {
    return Response.json({ error: 'Film not found' }, { status: 404 })
  }
  if (!film.sentimentGraph) {
    return Response.json({ error: 'Film has no sentiment graph' }, { status: 400 })
  }

  const rawDataPoints = film.sentimentGraph.dataPoints
  const dataPoints = (Array.isArray(rawDataPoints) ? rawDataPoints : []) as unknown as SentimentDataPoint[]

  const beats: Beat[] = [...dataPoints].sort((a, b) => a.timeMidpoint - b.timeMidpoint)

  const backdrops = await getMovieBackdropUrls(film.tmdbId)

  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : null

  return Response.json({
    film: {
      id: film.id,
      title: film.title,
      year,
      runtimeMinutes: film.runtime ?? 0,
      genres: film.genres ?? [],
      criticsScore: film.sentimentGraph.overallScore,
    },
    beats,
    backdrops,
  })
}
