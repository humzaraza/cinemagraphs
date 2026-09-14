import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentimentDataPoint } from '@/lib/types'
import type { SentimentGraphMeanDriftError as MeanDriftError } from '@/lib/sentiment-beat-lock'

// Await a promise that is expected to reject and hand back the error, typed.
async function rejectionOf(p: Promise<unknown>): Promise<MeanDriftError> {
  try {
    await p
  } catch (e) {
    return e as MeanDriftError
  }
  throw new Error('expected the write to be rejected')
}

// ── Write-path mean guard ────────────────────────────────────────────────────
//
// The generator validates the model's output, but the row that is persisted
// can differ from it: the beat-lock merge keeps old scores on preserved beats,
// and some callers move overallScore without touching beats at all. So the
// write path checks the row AS IT WILL BE WRITTEN against the headline it will
// carry, on every path, and refuses by throwing inside the transaction.

const mocks = vi.hoisted(() => ({
  childLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  tx: {
    $queryRaw: vi.fn(),
    sentimentGraph: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    sentimentGraphDriftLog: { create: vi.fn() },
  },
  // Rejections are recorded OUTSIDE the rolled-back transaction, on the
  // top-level client rather than the tx handle.
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

function noWriteHappened() {
  expect(mocks.tx.sentimentGraph.update).not.toHaveBeenCalled()
  expect(mocks.tx.sentimentGraph.create).not.toHaveBeenCalled()
}

// Existing beats average exactly 6.
const existingBeats = [beat('Opening', 0, 5), beat('Midpoint', 30, 6), beat('Climax', 60, 7)]

describe('safeWriteSentimentGraph mean guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SENTIMENT_BEAT_LOCK_ENABLED
    mocks.tx.$queryRaw.mockResolvedValue([])
    mocks.tx.sentimentGraph.update.mockResolvedValue({})
    mocks.tx.sentimentGraph.create.mockResolvedValue({})
    mocks.tx.sentimentGraphDriftLog.create.mockResolvedValue({})
    mocks.outerDriftLogCreate.mockResolvedValue({})
  })

  it('refuses the Scary Movie shape: no label matches, old beats kept, new headline far away', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph, SentimentGraphMeanDriftError } = await import('@/lib/sentiment-beat-lock')

    // Regenerated beats with entirely new labels, averaging 8.5, and a headline of 8.5.
    const incoming = [beat('Cold open', 0, 8), beat('Twist', 30, 9), beat('Finale', 60, 8.5)]
    const attempt = safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 8.5, previousScore: 6 },
      callerPath: 'admin-analyze',
    })

    await expect(attempt).rejects.toBeInstanceOf(SentimentGraphMeanDriftError)
    const err = await rejectionOf(attempt)
    expect(err.path).toBe('merge')
    expect(err.mean).toBeCloseTo(6, 6)
    expect(err.overallScore).toBe(8.5)
    expect(err.gap).toBeCloseTo(2.5, 6)
    expect(err.droppedIncomingLabels).toEqual(['Cold open', 'Twist', 'Finale'])
    expect(err.preservedExistingLabels).toEqual(['Opening', 'Midpoint', 'Climax'])

    // Nothing persisted, and no "accepted" drift record slipped out either.
    noWriteHappened()
    expect(mocks.tx.sentimentGraphDriftLog.create).not.toHaveBeenCalled()

    // The refusal is on record in the drift log, outside the transaction.
    expect(mocks.outerDriftLogCreate).toHaveBeenCalledTimes(1)
    const logged = mocks.outerDriftLogCreate.mock.calls[0][0].data
    expect(logged.action).toBe('rejected_mean_drift')
    expect(logged.callerPath).toBe('admin-analyze')
    expect(logged.existingBeatCount).toBe(3)
    expect(logged.incomingBeatCount).toBe(3)
    expect(logged.mismatchedLabels).toEqual(
      expect.arrayContaining([
        { incoming: 'Cold open', reason: 'not_in_existing' },
        { incoming: 'Opening', reason: 'missing_from_incoming' },
      ])
    )
    expect(mocks.childLogger.warn).toHaveBeenCalled()
  })

  it('accepts a merge whose merged scores agree with the new headline', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    // Same labels, new scores averaging 7.5, headline 7.5.
    const incoming = [beat('Opening', 0, 7), beat('Midpoint', 30, 7.5), beat('Climax', 60, 8)]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 7.5 },
      callerPath: 'cron-analyze',
    })

    expect(result.status).toBe('written')
    expect(mocks.tx.sentimentGraph.update).toHaveBeenCalledTimes(1)
    expect(mocks.outerDriftLogCreate).not.toHaveBeenCalled()
  })

  it('refuses a partial merge where preserved old scores drag the row away from the new headline', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph, SentimentGraphMeanDriftError } = await import('@/lib/sentiment-beat-lock')

    // Only Climax matches. Merged row: 5, 6 (preserved) and 9 -> mean 6.67 vs headline 8.
    const incoming = [beat('Renamed opening', 0, 8), beat('Climax', 60, 9)]
    const attempt = safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 8 },
      callerPath: 'cron-analyze',
    })

    await expect(attempt).rejects.toBeInstanceOf(SentimentGraphMeanDriftError)
    noWriteHappened()
  })

  it('refuses a headline-only shift that leaves the unchanged beats behind (score-refresh shape)', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph, SentimentGraphMeanDriftError } = await import('@/lib/sentiment-beat-lock')

    const attempt = safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: existingBeats,
      otherFields: { previousScore: 6, overallScore: 6.5 },
      callerPath: 'cron-refresh-scores',
    })

    await expect(attempt).rejects.toBeInstanceOf(SentimentGraphMeanDriftError)
    noWriteHappened()
  })

  it('accepts a headline-only shift that stays within tolerance of the beats', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: existingBeats,
      otherFields: { previousScore: 6, overallScore: 6.15 },
      callerPath: 'cron-refresh-scores',
    })

    expect(result.status).toBe('written')
    expect(mocks.tx.sentimentGraph.update).toHaveBeenCalledTimes(1)
  })

  it('checks against the headline already on the row when the caller sends none', async () => {
    // Row carries overallScore 8; merged beats average 6 -> refused.
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 8))
    const { safeWriteSentimentGraph, SentimentGraphMeanDriftError } = await import('@/lib/sentiment-beat-lock')

    const attempt = safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: existingBeats,
      otherFields: {},
      callerPath: 'cron-analyze',
    })
    await expect(attempt).rejects.toBeInstanceOf(SentimentGraphMeanDriftError)
    noWriteHappened()
  })

  it('refuses a first-ever write whose beats disagree with the headline', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(null)
    const { safeWriteSentimentGraph, SentimentGraphMeanDriftError } = await import('@/lib/sentiment-beat-lock')

    const attempt = safeWriteSentimentGraph({
      filmId: 'film-new',
      incomingDataPoints: existingBeats,
      otherFields: { overallScore: 7.4, anchoredFrom: 'imdb' },
      callerPath: 'cron-analyze',
    })

    await expect(attempt).rejects.toBeInstanceOf(SentimentGraphMeanDriftError)
    const err = await rejectionOf(attempt)
    expect(err.path).toBe('first_write')
    noWriteHappened()
  })

  it('applies the guard even with the beat lock disabled', async () => {
    process.env.SENTIMENT_BEAT_LOCK_ENABLED = 'false'
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow(existingBeats, 6))
    const { safeWriteSentimentGraph, SentimentGraphMeanDriftError } = await import('@/lib/sentiment-beat-lock')

    const attempt = safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: [beat('Anything', 0, 9)],
      otherFields: { overallScore: 6 },
      callerPath: 'admin-analyze',
    })

    await expect(attempt).rejects.toBeInstanceOf(SentimentGraphMeanDriftError)
    const err = await rejectionOf(attempt)
    expect(err.path).toBe('lock_disabled')
    noWriteHappened()
  })
})

describe('forceOverwriteSentimentGraph mean guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tx.$queryRaw.mockResolvedValue([])
    mocks.tx.sentimentGraph.update.mockResolvedValue({})
    mocks.tx.sentimentGraph.create.mockResolvedValue({})
  })

  it('refuses a verbatim overwrite whose beats disagree with the headline', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow([beat('Old', 0, 3)], 3))
    const { forceOverwriteSentimentGraph, SentimentGraphMeanDriftError } = await import('@/lib/sentiment-beat-lock')

    const attempt = forceOverwriteSentimentGraph({
      filmId: 'film-1',
      dataPoints: existingBeats,
      otherFields: { overallScore: 7 },
      callerPath: 'script-backfill-graph-mean',
    })

    await expect(attempt).rejects.toBeInstanceOf(SentimentGraphMeanDriftError)
    const err = await rejectionOf(attempt)
    expect(err.path).toBe('force_overwrite')
    noWriteHappened()
    // No drift-log row for force writes; the warn is the record.
    expect(mocks.outerDriftLogCreate).not.toHaveBeenCalled()
    expect(mocks.childLogger.warn).toHaveBeenCalled()
  })

  it('accepts a verbatim overwrite that agrees with its headline', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(existingRow([beat('Old', 0, 3)], 3))
    const { forceOverwriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')

    await forceOverwriteSentimentGraph({
      filmId: 'film-1',
      dataPoints: existingBeats,
      otherFields: { overallScore: 6.1 },
      callerPath: 'script-backfill-graph-mean',
    })
    expect(mocks.tx.sentimentGraph.update).toHaveBeenCalledTimes(1)
  })
})
