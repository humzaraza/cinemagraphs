import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentimentDataPoint } from '@/lib/types'

// ── overallScore is derived from the beats being written ─────────────────────
//
// A film's headline is the mean of its beat scores, rounded to one decimal,
// computed in code from the beats the row will actually hold. Every write path
// (first write, beat-lock merge, lock disabled, force overwrite) replaces a
// caller-supplied overallScore with that derivation, so no path can persist a
// headline that disagrees with its beats. The tolerance check stays in place
// as a backstop only.

const mocks = vi.hoisted(() => ({
  childLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  tx: {
    $queryRaw: vi.fn(),
    sentimentGraph: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    sentimentGraphDriftLog: { create: vi.fn() },
  },
  outerDriftLogCreate: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({ logger: { child: () => mocks.childLogger } }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: async <T>(fn: (tx: typeof mocks.tx) => Promise<T>): Promise<T> => fn(mocks.tx),
    sentimentGraphDriftLog: { create: mocks.outerDriftLogCreate },
  },
}))

function beat(label: string, timeStart: number, score: number): SentimentDataPoint {
  return {
    label,
    labelFull: `${label} described in full`,
    timeStart,
    timeEnd: timeStart + 10,
    timeMidpoint: timeStart + 5,
    score,
    confidence: 'medium',
    reviewEvidence: `evidence for ${label}`,
  }
}

function existingRow(dataPoints: SentimentDataPoint[], overallScore?: number) {
  return { id: 'g1', filmId: 'film-1', dataPoints, ...(overallScore !== undefined ? { overallScore } : {}) }
}

function writtenData(): Record<string, unknown> {
  const updateCall = mocks.tx.sentimentGraph.update.mock.calls[0]
  if (updateCall) return updateCall[0].data
  const createCall = mocks.tx.sentimentGraph.create.mock.calls[0]
  if (createCall) return createCall[0].data
  throw new Error('No sentimentGraph write happened')
}

// Existing beats average exactly 6.
const existingBeats = [beat('Opening', 0, 5), beat('Midpoint', 30, 6), beat('Climax', 60, 7)]

describe('safeWriteSentimentGraph derives overallScore from the written beats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SENTIMENT_BEAT_LOCK_ENABLED
    // Default: the film HAS user beat ratings, so the merge path runs.
    mocks.tx.$queryRaw.mockResolvedValue([{ rated: 1 }])
    mocks.tx.sentimentGraph.update.mockResolvedValue({})
    mocks.tx.sentimentGraph.create.mockResolvedValue({})
    mocks.tx.sentimentGraphDriftLog.create.mockResolvedValue({})
    mocks.outerDriftLogCreate.mockResolvedValue({})
  })

  it('Scary Movie shape on a film with NO beat ratings: new beats replace old ones, headline is their mean', async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{ rated: 0 }])
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    const incoming = [beat('Cold open', 0, 8), beat('Twist', 30, 9), beat('Finale', 60, 8.5)]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 9.9, previousScore: 6 },
      callerPath: 'admin-analyze',
    })

    expect(result.status).toBe('written')
    expect(result.replacedExistingLabels).toEqual(['Opening', 'Midpoint', 'Climax'])
    const data = writtenData()
    expect((data.dataPoints as SentimentDataPoint[]).map((b) => b.label)).toEqual(['Cold open', 'Twist', 'Finale'])
    expect(data.overallScore).toBe(8.5)
    expect(data.previousScore).toBe(6)
  })

  it('Scary Movie shape on a film WITH beat ratings: no label matches, old beats kept, old mean is the headline', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    // Regenerated beats with entirely new labels averaging 8.5; the caller
    // also claims 8.5. Every incoming beat is dropped by the lock.
    const incoming = [beat('Cold open', 0, 8), beat('Twist', 30, 9), beat('Finale', 60, 8.5)]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 8.5, previousScore: 6 },
      callerPath: 'admin-analyze',
    })

    expect(result.status).toBe('written_with_drops')
    const data = writtenData()
    // The row holds the old beats, so its headline is their mean, not 8.5.
    expect(data.overallScore).toBe(6)
    expect(data.previousScore).toBe(6)
    expect((data.dataPoints as SentimentDataPoint[]).map((b) => b.label)).toEqual(['Opening', 'Midpoint', 'Climax'])
    // No refusal: nothing drifted, so no rejected_mean_drift record.
    expect(mocks.outerDriftLogCreate).not.toHaveBeenCalled()
  })

  it('full label match: headline is the mean of the merged new scores', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    // New scores 7, 7.5, 8 average 7.5. The caller's 9.9 is ignored.
    const incoming = [beat('Opening', 0, 7), beat('Midpoint', 30, 7.5), beat('Climax', 60, 8)]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 9.9 },
      callerPath: 'cron-analyze',
    })

    expect(result.status).toBe('written')
    expect(writtenData().overallScore).toBe(7.5)
  })

  it('partial match: preserved old scores count toward the headline', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    // Only Climax matches. Merged row: 5, 6 (preserved) and 9 -> mean 6.667 -> 6.7.
    const incoming = [beat('Renamed opening', 0, 8), beat('Climax', 60, 9)]
    await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 8 },
      callerPath: 'cron-analyze',
    })

    expect(writtenData().overallScore).toBe(6.7)
  })

  it('headline-only write (score-refresh shape) cannot move the score off its beats', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: existingBeats,
      otherFields: { previousScore: 6, overallScore: 6.5 },
      callerPath: 'cron-refresh-scores',
    })

    expect(writtenData().overallScore).toBe(6)
  })

  it('derives a headline even when the caller sends none', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 8))
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: existingBeats,
      otherFields: {},
      callerPath: 'cron-analyze',
    })

    // The row said 8; the beats say 6; the beats win.
    expect(writtenData().overallScore).toBe(6)
  })

  it('first-ever write: headline is the beat mean, rounded', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(null)
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    // 6, 5.5, 9 average 6.8333 -> 6.8
    const incoming = [beat('A', 0, 6), beat('B', 30, 5.5), beat('C', 60, 9)]
    await safeWriteSentimentGraph({
      filmId: 'film-new',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 7.4, anchoredFrom: 'imdb' },
      callerPath: 'cron-analyze',
    })

    expect(mocks.tx.sentimentGraph.create).toHaveBeenCalledTimes(1)
    const data = writtenData()
    expect(data.overallScore).toBe(6.8)
    expect(data.anchoredFrom).toBe('imdb')
  })

  it('lock disabled: still derives from the incoming beats', async () => {
    process.env.SENTIMENT_BEAT_LOCK_ENABLED = 'false'
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: [beat('Anything', 0, 9)],
      otherFields: { overallScore: 6 },
      callerPath: 'admin-analyze',
    })

    expect(writtenData().overallScore).toBe(9)
  })

  it('arcShape is classified against the derived headline, not the caller value', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(null)
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')
    const { classifyArcShape } = await import('@/lib/arc-classifier')

    // A clean nosedive: opens at the max, falls steadily to the floor.
    const incoming = [beat('Open', 0, 9), beat('Slip', 15, 8), beat('Slide', 30, 6), beat('Sink', 45, 5), beat('Floor', 60, 4)]
    await safeWriteSentimentGraph({
      filmId: 'film-arc',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 9.5 },
      callerPath: 'test',
    })

    const data = writtenData()
    expect(data.overallScore).toBe(6.4)
    expect(data.arcShape).toEqual(classifyArcShape(incoming, 6.4))
  })
})

describe('forceOverwriteSentimentGraph derives overallScore from the written beats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tx.$queryRaw.mockResolvedValue([])
    mocks.tx.sentimentGraph.update.mockResolvedValue({})
    mocks.tx.sentimentGraph.create.mockResolvedValue({})
  })

  it('replaces the caller headline with the beat mean', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow([beat('Old', 0, 3)], 3))
    const { forceOverwriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    await forceOverwriteSentimentGraph({
      filmId: 'film-1',
      dataPoints: existingBeats,
      otherFields: { overallScore: 7, previousScore: 3 },
      callerPath: 'script-backfill-graph-mean',
    })

    expect(mocks.tx.sentimentGraph.update).toHaveBeenCalledTimes(1)
    const data = writtenData()
    expect(data.overallScore).toBe(6)
    expect(data.previousScore).toBe(3)
    expect(mocks.childLogger.warn).toHaveBeenCalled() // the usual force-overwrite warn
    expect(mocks.outerDriftLogCreate).not.toHaveBeenCalled()
  })
})
