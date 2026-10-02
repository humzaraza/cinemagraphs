import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentimentDataPoint } from '@/lib/types'

// The blender re-blends from the critic beats every time, counts every
// approved review that rated beats (text or not), and treats reaction
// scores as already on the 1 to 10 scale.

const mocks = vi.hoisted(() => ({
  prisma: {
    sentimentGraph: { findUnique: vi.fn() },
    userReview: { findMany: vi.fn() },
    liveReactionSession: { findMany: vi.fn() },
    liveReaction: { findMany: vi.fn() },
  },
  safeWriteSentimentGraph: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/sentiment-beat-lock', () => ({ safeWriteSentimentGraph: mocks.safeWriteSentimentGraph }))

function beat(label: string, timeStart: number, score: number): SentimentDataPoint {
  return {
    label,
    timeStart,
    timeEnd: timeStart + 10,
    timeMidpoint: timeStart + 5,
    score,
    confidence: 'medium',
    reviewEvidence: '',
  }
}

const critic = [beat('Opening', 0, 6), beat('Midpoint', 10, 7), beat('Climax', 20, 8)]
// A previously blended view, drifted toward the users. Must NOT be the base.
const blendedBefore = [beat('Opening', 0, 9), beat('Midpoint', 10, 9), beat('Climax', 20, 9)]

function fiveRatedReviews(opening: number) {
  // Five reviews, all rating Opening, none carrying text or sentiment.
  return Array.from({ length: 5 }, () => ({ beatRatings: { Opening: opening } }))
}

describe('maybeBlendAndUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prisma.liveReactionSession.findMany.mockResolvedValue([])
    mocks.prisma.liveReaction.findMany.mockResolvedValue([])
    mocks.safeWriteSentimentGraph.mockResolvedValue({ status: 'written' })
  })

  it('blends from criticDataPoints, not from the previously blended dataPoints', async () => {
    mocks.prisma.sentimentGraph.findUnique.mockResolvedValue({
      overallScore: 9,
      dataPoints: blendedBefore,
      criticDataPoints: critic,
    })
    mocks.prisma.userReview.findMany.mockResolvedValue(fiveRatedReviews(10))

    const { maybeBlendAndUpdate } = await import('@/lib/review-blender')
    await maybeBlendAndUpdate('film-1')

    expect(mocks.safeWriteSentimentGraph).toHaveBeenCalledTimes(1)
    const args = mocks.safeWriteSentimentGraph.mock.calls[0][0]
    const written = args.incomingDataPoints as SentimentDataPoint[]
    // Opening: 6 * 0.6 + 10 * 0.4 = 7.6 from the CRITIC 6, not the blended 9.
    expect(written.find((b) => b.label === 'Opening')?.score).toBe(7.6)
    // Beats nobody rated keep the critic score (weights renormalised).
    expect(written.find((b) => b.label === 'Midpoint')?.score).toBe(7)
    expect(written.find((b) => b.label === 'Climax')?.score).toBe(8)
    expect(args.otherFields.varianceSource).toBe('blended')
    expect(args.callerPath).toBe('review-blender')
    // Headline is the mean of what is written: (7.6 + 7 + 8) / 3 = 7.533 -> 7.5
    expect(args.otherFields.overallScore).toBe(7.5)
  })

  it('counts reviews with beat ratings and no text (no sentiment filter)', async () => {
    mocks.prisma.sentimentGraph.findUnique.mockResolvedValue({
      overallScore: 7,
      dataPoints: critic,
      criticDataPoints: critic,
    })
    mocks.prisma.userReview.findMany.mockResolvedValue(fiveRatedReviews(2))

    const { maybeBlendAndUpdate } = await import('@/lib/review-blender')
    await maybeBlendAndUpdate('film-1')

    // The query must not filter on sentiment.
    const where = mocks.prisma.userReview.findMany.mock.calls[0][0].where
    expect(where).toEqual({ filmId: 'film-1', status: 'approved' })
    expect(mocks.safeWriteSentimentGraph).toHaveBeenCalledTimes(1)
  })

  it('does nothing below five rating reviews and twenty reactions', async () => {
    mocks.prisma.sentimentGraph.findUnique.mockResolvedValue({
      overallScore: 7,
      dataPoints: critic,
      criticDataPoints: critic,
    })
    mocks.prisma.userReview.findMany.mockResolvedValue([
      ...fiveRatedReviews(9).slice(0, 4),
      { beatRatings: null }, // a text-only review does not count as a rater
    ])

    const { maybeBlendAndUpdate } = await import('@/lib/review-blender')
    await maybeBlendAndUpdate('film-1')
    expect(mocks.safeWriteSentimentGraph).not.toHaveBeenCalled()
  })

  it('falls back to dataPoints as the base on a legacy row with no criticDataPoints', async () => {
    mocks.prisma.sentimentGraph.findUnique.mockResolvedValue({
      overallScore: 7,
      dataPoints: critic,
      criticDataPoints: null,
    })
    mocks.prisma.userReview.findMany.mockResolvedValue(fiveRatedReviews(10))

    const { maybeBlendAndUpdate } = await import('@/lib/review-blender')
    await maybeBlendAndUpdate('film-1')
    const written = mocks.safeWriteSentimentGraph.mock.calls[0][0].incomingDataPoints as SentimentDataPoint[]
    expect(written.find((b) => b.label === 'Opening')?.score).toBe(7.6)
  })

  it('treats reaction scores as 1 to 10 and writes on reactions alone', async () => {
    mocks.prisma.sentimentGraph.findUnique.mockResolvedValue({
      overallScore: 7,
      dataPoints: critic,
      criticDataPoints: critic,
    })
    mocks.prisma.userReview.findMany.mockResolvedValue([])
    mocks.prisma.liveReactionSession.findMany.mockResolvedValue([{ id: 's1' }])
    // Twenty reactions in the Opening window (0 to 10 minutes), all scoring 2.
    mocks.prisma.liveReaction.findMany.mockResolvedValue(
      Array.from({ length: 20 }, () => ({ reaction: 'down', score: 2, sessionTimestamp: 120 }))
    )

    const { maybeBlendAndUpdate } = await import('@/lib/review-blender')
    await maybeBlendAndUpdate('film-1')

    expect(mocks.safeWriteSentimentGraph).toHaveBeenCalledTimes(1)
    const written = mocks.safeWriteSentimentGraph.mock.calls[0][0].incomingDataPoints as SentimentDataPoint[]
    // Opening: 6 * 0.8 + 2 * 0.2 = 5.2. With the old -1..1 mapping this
    // bucket would have been 5 + 2 * 5 = 15, clamped to 10.
    expect(written.find((b) => b.label === 'Opening')?.score).toBe(5.2)
    expect(written.find((b) => b.label === 'Midpoint')?.score).toBe(7)
  })
})
