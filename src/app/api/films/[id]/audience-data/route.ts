import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import type { SentimentDataPoint } from '@/lib/types'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: filmId } = await params

    // Approved user reviews with beat ratings
    const reviews = await prisma.userReview.findMany({
      where: { filmId, status: 'approved' },
      select: { beatRatings: true, overallRating: true },
    })

    // Average beat ratings per label
    const beatTotals: Record<string, { total: number; count: number }> = {}
    for (const review of reviews) {
      if (!review.beatRatings) continue
      const ratings = review.beatRatings as Record<string, number>
      for (const [label, score] of Object.entries(ratings)) {
        if (!beatTotals[label]) beatTotals[label] = { total: 0, count: 0 }
        beatTotals[label].total += score
        beatTotals[label].count++
      }
    }
    const beatAverages: Record<string, number> = {}
    for (const [label, { total, count }] of Object.entries(beatTotals)) {
      beatAverages[label] = Math.round((total / count) * 10) / 10
    }

    // Quality live reaction sessions (50%+ completion, not flagged)
    const liveSessionCount = await prisma.liveReactionSession.count({
      where: { filmId, completionRate: { gte: 0.5 }, flagged: false },
    })

    // Aggregate live reactions into time-bucketed scores (normalized to 1-10 scale)
    let reactionScores: { index: number; score: number }[] = []
    if (liveSessionCount >= 20) {
      const qualitySessions = await prisma.liveReactionSession.findMany({
        where: { filmId, completionRate: { gte: 0.5 }, flagged: false },
        select: { id: true },
      })
      const sessionIds = qualitySessions.map((s) => s.id)

      const reactions = await prisma.liveReaction.findMany({
        where: {
          filmId,
          OR: [{ sessionId: { in: sessionIds } }, { sessionId: null }],
        },
        select: { score: true, sessionTimestamp: true },
      })

      const graph = await prisma.sentimentGraph.findUnique({
        where: { filmId },
        select: { dataPoints: true },
      })

      if (graph?.dataPoints) {
        const dps = graph.dataPoints as unknown as SentimentDataPoint[]
        const buckets: Record<number, { total: number; count: number }> = {}

        for (const reaction of reactions) {
          const minutes = reaction.sessionTimestamp / 60
          for (let i = 0; i < dps.length; i++) {
            if (minutes >= dps[i].timeStart && minutes <= dps[i].timeEnd) {
              if (!buckets[i]) buckets[i] = { total: 0, count: 0 }
              buckets[i].total += reaction.score
              buckets[i].count++
              break
            }
          }
        }

        // Normalize reaction averages to 1-10 scale (centered at 5)
        reactionScores = Object.entries(buckets).map(([i, b]) => ({
          index: Number(i),
          score: Math.max(1, Math.min(10, 5 + (b.total / b.count) * 5)),
        }))
      }
    }

    return Response.json({
      userReviewCount: reviews.length,
      beatAverages,
      liveSessionCount,
      reactionScores,
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch audience data')
    return Response.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
