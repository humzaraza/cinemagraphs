import type { PrismaClient } from '@/generated/prisma/client'
import type { SentimentDataPoint } from '@/lib/types'

export async function seedTestFilm(
  prismaClient: PrismaClient,
  existingDataPoints?: SentimentDataPoint[]
): Promise<{ filmId: string }> {
  const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
  const filmId = `test-3b3-${uniqueSuffix}`
  // tmdbId is a unique Int column; derive a collision-resistant negative id so
  // we can't collide with real TMDB ids (which are always positive) or with
  // other seeded films created inside the same integration run.
  const tmdbId = -Math.floor(Math.random() * 1_000_000_000) - 1

  await prismaClient.film.create({
    data: {
      id: filmId,
      tmdbId,
      title: `Integration Test Film ${uniqueSuffix}`,
      status: 'ACTIVE',
    },
  })

  if (existingDataPoints) {
    await prismaClient.sentimentGraph.create({
      data: {
        filmId,
        overallScore: 7,
        anchoredFrom: 'integration-test',
        dataPoints: existingDataPoints as unknown as object,
        reviewCount: 0,
        sourcesUsed: [],
      },
    })
  }

  return { filmId }
}
