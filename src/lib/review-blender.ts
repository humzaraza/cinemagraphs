import { prisma } from './prisma'
import { safeWriteSentimentGraph } from './sentiment-beat-lock'
import { overallScoreFromBeats } from './sentiment-guards'
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
 * Blend audience signal into a film's sentiment graph. Called after a review
 * or reaction is submitted.
 *
 * Inputs:
 *  - critic beats: `criticDataPoints`, the graph exactly as generated. Legacy
 *    rows blended before that column existed fall back to `dataPoints`. The
 *    blend is always computed from this base, never from its own previous
 *    output, so repeated blends do not compound toward the user averages.
 *  - user beat ratings from every approved review that carries any. Reviews
 *    with no text count too; a user's overall slider and the AI text
 *    sentiment never enter the graph.
 *  - live reactions from quality sessions, already on the 1 to 10 scale.
 *
 * Each beat is a weighted mean over the sources that actually have a value
 * for it, with the weights renormalised per beat, so a beat nobody rated is
 * not inflated by an unweighted critic score plus a reaction term.
 *
 * The write goes through the beat-lock merge: the film has beat ratings by
 * definition when reviews are blended, so labels and timestamps stay fixed
 * and only scores move. overallScore is derived from the blended beats by
 * the write path.
 */
export async function maybeBlendAndUpdate(filmId: string): Promise<void> {
  const graph = await prisma.sentimentGraph.findUnique({
    where: { filmId },
    select: { overallScore: true, dataPoints: true, criticDataPoints: true },
  })
  if (!graph) return // no graph to blend into

  const userReviews = await prisma.userReview.findMany({
    where: { filmId, status: 'approved' },
    select: { beatRatings: true },
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

  // Beat averages across every review that rated beats, keyed by label.
  const beatAverages = averageBeatRatings(userReviews.map((r) => r.beatRatings))
  const ratedReviewCount = userReviews.filter((r) => hasBeatRatings(r.beatRatings)).length

  const hasEnoughReviews = ratedReviewCount >= MIN_USER_REVIEWS_FOR_BLEND
  const hasEnoughReactions = liveReactions.length >= MIN_LIVE_REACTIONS_FOR_BLEND
  if (!hasEnoughReviews && !hasEnoughReactions) return

  const weights = getBlendWeights(hasEnoughReviews, hasEnoughReactions)
  const base = (
    Array.isArray(graph.criticDataPoints) && graph.criticDataPoints.length > 0
      ? graph.criticDataPoints
      : graph.dataPoints
  ) as unknown as SentimentDataPoint[]

  const buckets = hasEnoughReactions ? aggregateReactionsIntoBuckets(liveReactions, base) : {}

  const blendedPoints = base.map((dp, i) => {
    const userAvg = hasEnoughReviews ? beatAverages[dp.label] : undefined
    const reaction = hasEnoughReactions ? buckets[i] : undefined
    let numerator = dp.score * weights.external
    let denominator = weights.external
    if (userAvg !== undefined) {
      numerator += userAvg * weights.userReviews
      denominator += weights.userReviews
    }
    if (reaction !== undefined) {
      numerator += reaction * weights.liveReactions
      denominator += weights.liveReactions
    }
    return { ...dp, score: Math.round((numerator / denominator) * 10) / 10 }
  })

  await safeWriteSentimentGraph({
    filmId,
    incomingDataPoints: blendedPoints,
    otherFields: {
      previousScore: graph.overallScore,
      overallScore: overallScoreFromBeats(blendedPoints),
      varianceSource: 'blended',
    },
    callerPath: 'review-blender',
  })
}

function hasBeatRatings(value: unknown): value is Record<string, number> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.values(value as Record<string, unknown>).some((v) => typeof v === 'number')
  )
}

export function averageBeatRatings(ratingSets: ReadonlyArray<unknown>): Record<string, number> {
  const totals: Record<string, { total: number; count: number }> = {}
  for (const ratings of ratingSets) {
    if (!hasBeatRatings(ratings)) continue
    for (const [label, score] of Object.entries(ratings)) {
      if (typeof score !== 'number' || !Number.isFinite(score)) continue
      if (!totals[label]) totals[label] = { total: 0, count: 0 }
      totals[label].total += score
      totals[label].count++
    }
  }
  const averages: Record<string, number> = {}
  for (const [label, { total, count }] of Object.entries(totals)) {
    averages[label] = total / count
  }
  return averages
}

/**
 * Average reaction score per beat. LiveReaction.score is stored on the 1 to
 * 10 scale (reactions/route.ts), so the bucket average needs no rescaling.
 */
export function aggregateReactionsIntoBuckets(
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
    result[Number(i)] = Math.max(1, Math.min(10, bucket.total / bucket.count))
  }
  return result
}
