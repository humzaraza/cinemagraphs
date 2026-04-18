import { prisma } from './prisma'
import { safeWriteSentimentGraph } from './sentiment-beat-lock'
import type { SentimentDataPoint } from './types'

const MIN_USER_REVIEWS_FOR_BLEND = 5
const MIN_LIVE_REACTIONS_FOR_BLEND = 20

interface BlendWeights {
  external: number
  userReviews: number
  liveReactions: number
}

function getBlendWeights(hasUserReviews: boolean, hasLiveReactions: boolean): BlendWeights {
  if (hasUserReviews && hasLiveReactions) {
    return { external: 0.5, userReviews: 0.3, liveReactions: 0.2 }
  }
  if (hasUserReviews) {
    return { external: 0.6, userReviews: 0.4, liveReactions: 0 }
  }
  if (hasLiveReactions) {
    return { external: 0.8, userReviews: 0, liveReactions: 0.2 }
  }
  return { external: 1, userReviews: 0, liveReactions: 0 }
}

/**
 * Check if blending should happen and trigger it for a film.
 * Called after review submission or reaction submission.
 */
export async function maybeBlendAndUpdate(filmId: string): Promise<void> {
  const graph = await prisma.sentimentGraph.findUnique({ where: { filmId } })
  if (!graph) return // no graph to blend into

  const userReviews = await prisma.userReview.findMany({
    where: { filmId, status: 'approved', sentiment: { not: null } },
    select: { sentiment: true, beatRatings: true },
  })

  // Only include reactions from quality sessions (50%+ completion, not flagged)
  const qualitySessions = await prisma.liveReactionSession.findMany({
    where: { filmId, completionRate: { gte: 0.5 }, flagged: false },
    select: { id: true },
  })
  const qualitySessionIds = qualitySessions.map((s) => s.id)

  const liveReactions = await prisma.liveReaction.findMany({
    where: {
      filmId,
      OR: [
        { sessionId: { in: qualitySessionIds } },
        // Include legacy reactions without sessions
        { sessionId: null },
      ],
    },
    select: { reaction: true, score: true, sessionTimestamp: true },
  })

  const hasEnoughReviews = userReviews.length >= MIN_USER_REVIEWS_FOR_BLEND
  const hasEnoughReactions = liveReactions.length >= MIN_LIVE_REACTIONS_FOR_BLEND

  if (!hasEnoughReviews && !hasEnoughReactions) return

  const weights = getBlendWeights(hasEnoughReviews, hasEnoughReactions)
  const dataPoints = graph.dataPoints as unknown as SentimentDataPoint[]

  // Blend user review beat ratings into data points
  let blendedPoints = dataPoints.map((dp) => ({ ...dp }))

  if (hasEnoughReviews) {
    // Average beat ratings across all user reviews
    const beatAverages: Record<string, { total: number; count: number }> = {}
    for (const review of userReviews) {
      if (!review.beatRatings) continue
      const ratings = review.beatRatings as Record<string, number>
      for (const [label, score] of Object.entries(ratings)) {
        if (!beatAverages[label]) beatAverages[label] = { total: 0, count: 0 }
        beatAverages[label].total += score
        beatAverages[label].count++
      }
    }

    // Blend averaged beat ratings into matching data points
    blendedPoints = blendedPoints.map((dp) => {
      const avg = beatAverages[dp.label]
      if (avg && avg.count > 0) {
        const userAvg = avg.total / avg.count
        dp.score = dp.score * weights.external + userAvg * weights.userReviews
        if (hasEnoughReactions) {
          // Leave room for reaction blend below
        } else {
          dp.score = dp.score / (weights.external + weights.userReviews)
        }
      }
      return dp
    })

    // Blend overall score with user review sentiments
    const avgSentiment =
      userReviews.reduce((sum, r) => sum + (r.sentiment ?? 0), 0) / userReviews.length
    const blendedOverall =
      graph.overallScore * weights.external + avgSentiment * weights.userReviews

    // Blend live reactions into time buckets if applicable
    if (hasEnoughReactions) {
      const buckets = aggregateReactionsIntoBuckets(liveReactions, blendedPoints)
      blendedPoints = blendedPoints.map((dp, i) => {
        if (buckets[i] !== undefined) {
          dp.score = dp.score + buckets[i] * weights.liveReactions
        }
        return dp
      })
    }

    const finalOverall = hasEnoughReactions
      ? blendedOverall +
        (liveReactions.reduce((sum, r) => sum + r.score, 0) / liveReactions.length) *
          weights.liveReactions
      : blendedOverall / (weights.external + weights.userReviews)

    await safeWriteSentimentGraph({
      filmId,
      incomingDataPoints: blendedPoints,
      otherFields: {
        previousScore: graph.overallScore,
        overallScore: Math.round(Math.max(1, Math.min(10, finalOverall)) * 10) / 10,
        varianceSource: 'blended',
      },
      callerPath: 'review-blender',
    })
  }
}

function aggregateReactionsIntoBuckets(
  reactions: { score: number; sessionTimestamp: number }[],
  dataPoints: SentimentDataPoint[]
): Record<number, number> {
  const buckets: Record<number, { total: number; count: number }> = {}

  for (const reaction of reactions) {
    const minutes = reaction.sessionTimestamp / 60
    // Find which data point bucket this reaction falls into
    for (let i = 0; i < dataPoints.length; i++) {
      if (minutes >= dataPoints[i].timeStart && minutes <= dataPoints[i].timeEnd) {
        if (!buckets[i]) buckets[i] = { total: 0, count: 0 }
        buckets[i].total += reaction.score
        buckets[i].count++
        break
      }
    }
  }

  const result: Record<number, number> = {}
  for (const [i, bucket] of Object.entries(buckets)) {
    result[Number(i)] = bucket.total / bucket.count
  }
  return result
}
