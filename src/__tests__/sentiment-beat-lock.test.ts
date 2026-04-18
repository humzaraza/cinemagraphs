import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { SentimentDataPoint } from '@/lib/types'

// ── Hoisted mocks ───────────────────────────────────────────────────────────
//
// vi.mock factories are hoisted above ordinary `const` declarations, so the
// mock-shared state has to be declared via vi.hoisted for the factories to
// see it. Every mocked function is also spyable from individual tests.

const mocks = vi.hoisted(() => ({
  childLogger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
  tx: {
    $queryRaw: vi.fn(),
    sentimentGraph: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    sentimentGraphDriftLog: {
      create: vi.fn(),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => mocks.childLogger,
  },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: async <T>(fn: (tx: typeof mocks.tx) => Promise<T>): Promise<T> =>
      fn(mocks.tx),
  },
}))

// ── Fixtures ────────────────────────────────────────────────────────────────

function beat(
  label: string,
  timeStart: number,
  score: number,
  extra: Partial<SentimentDataPoint> = {}
): SentimentDataPoint {
  return {
    label,
    timeStart,
    timeEnd: timeStart + 10,
    timeMidpoint: timeStart + 5,
    score,
    confidence: 'medium',
    reviewEvidence: `evidence for ${label}`,
    ...extra,
  }
}

function resetMocks() {
  mocks.childLogger.warn.mockReset()
  mocks.childLogger.info.mockReset()
  mocks.childLogger.error.mockReset()
  mocks.tx.$queryRaw.mockReset()
  mocks.tx.sentimentGraph.findUnique.mockReset()
  mocks.tx.sentimentGraph.update.mockReset()
  mocks.tx.sentimentGraph.create.mockReset()
  mocks.tx.sentimentGraphDriftLog.create.mockReset()

  // Default: the FOR UPDATE lock query and the write mutations resolve
  // cleanly. Individual tests override findUnique per-case.
  mocks.tx.$queryRaw.mockResolvedValue([])
  mocks.tx.sentimentGraph.update.mockResolvedValue({})
  mocks.tx.sentimentGraph.create.mockResolvedValue({})
  mocks.tx.sentimentGraphDriftLog.create.mockResolvedValue({})
}

// Helper to pull the dataPoints that were passed into whichever write fired.
function capturedDataPoints(): SentimentDataPoint[] {
  const updateCall = mocks.tx.sentimentGraph.update.mock.calls[0]
  if (updateCall) return updateCall[0].data.dataPoints as SentimentDataPoint[]
  const createCall = mocks.tx.sentimentGraph.create.mock.calls[0]
  if (createCall) return createCall[0].data.dataPoints as SentimentDataPoint[]
  throw new Error('No sentimentGraph write happened')
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('safeWriteSentimentGraph', () => {
  beforeEach(() => {
    resetMocks()
    delete process.env.SENTIMENT_BEAT_LOCK_ENABLED
  })

  afterEach(() => {
    delete process.env.SENTIMENT_BEAT_LOCK_ENABLED
  })

  it('A. first-ever write — no existing graph, all incoming accepted, no drift log', async () => {
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce(null)

    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')
    const incoming = [beat('Opening', 0, 6), beat('Climax', 60, 8)]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 7, anchoredFrom: 'imdb' },
      callerPath: 'test',
    })

    expect(result.status).toBe('written')
    expect(result.acceptedBeatCount).toBe(2)
    expect(result.droppedIncomingLabels).toEqual([])
    expect(result.preservedExistingLabels).toEqual([])

    // No existing row → helper creates, not updates.
    expect(mocks.tx.sentimentGraph.create).toHaveBeenCalledTimes(1)
    expect(mocks.tx.sentimentGraph.update).not.toHaveBeenCalled()
    expect(capturedDataPoints()).toEqual(incoming)

    // No drift log on a first-ever write — there's nothing to drift from.
    expect(mocks.tx.sentimentGraphDriftLog.create).not.toHaveBeenCalled()

    // Row-level lock was taken inside the transaction.
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('B. exact label match — scores updated, timestamps preserved, no drift log', async () => {
    const existingBeats = [
      beat('Opening', 0, 4),
      beat('Rising', 30, 5),
      beat('Climax', 60, 7),
    ]
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce({
      id: 'g1',
      filmId: 'film-1',
      dataPoints: existingBeats,
    })

    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')
    // Same labels, same count, but the scores/confidence/reviewEvidence move.
    const incoming = [
      beat('Opening', 999, 6, { confidence: 'high', reviewEvidence: 'new ev O' }),
      beat('Rising', 999, 5.5, { confidence: 'high', reviewEvidence: 'new ev R' }),
      beat('Climax', 999, 9, { confidence: 'high', reviewEvidence: 'new ev C' }),
    ]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 7.2 },
      callerPath: 'review-blender',
    })

    expect(result.status).toBe('written')
    expect(result.acceptedBeatCount).toBe(3)
    expect(result.droppedIncomingLabels).toEqual([])
    expect(result.preservedExistingLabels).toEqual([])

    expect(mocks.tx.sentimentGraph.update).toHaveBeenCalledTimes(1)
    const merged = capturedDataPoints()
    expect(merged).toEqual([
      { ...existingBeats[0], score: 6, confidence: 'high', reviewEvidence: 'new ev O' },
      { ...existingBeats[1], score: 5.5, confidence: 'high', reviewEvidence: 'new ev R' },
      { ...existingBeats[2], score: 9, confidence: 'high', reviewEvidence: 'new ev C' },
    ])

    // Labels + count match exactly → no drift.
    expect(mocks.tx.sentimentGraphDriftLog.create).not.toHaveBeenCalled()
  })

  it('C. extra incoming label — incoming beat dropped, drift log with write_accepted_with_drops', async () => {
    const existingBeats = [beat('Opening', 0, 5), beat('Climax', 60, 8)]
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce({
      id: 'g1',
      filmId: 'film-1',
      dataPoints: existingBeats,
    })

    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')
    const incoming = [
      beat('Opening', 0, 6),
      beat('Climax', 60, 7),
      beat('Rogue New Beat', 90, 4),
    ]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: {},
      callerPath: 'cron-analyze',
    })

    expect(result.status).toBe('written_with_drops')
    expect(result.droppedIncomingLabels).toEqual(['Rogue New Beat'])
    expect(result.preservedExistingLabels).toEqual([])

    expect(capturedDataPoints().map((b) => b.label)).toEqual(['Opening', 'Climax'])

    expect(mocks.tx.sentimentGraphDriftLog.create).toHaveBeenCalledTimes(1)
    const driftArg = mocks.tx.sentimentGraphDriftLog.create.mock.calls[0][0].data
    expect(driftArg.action).toBe('write_accepted_with_drops')
    expect(driftArg.filmId).toBe('film-1')
    expect(driftArg.callerPath).toBe('cron-analyze')
    expect(driftArg.existingBeatCount).toBe(2)
    expect(driftArg.incomingBeatCount).toBe(3)
    expect(driftArg.envLockEnabled).toBe(true)
    expect(driftArg.mismatchedLabels).toEqual([
      { incoming: 'Rogue New Beat', reason: 'not_in_existing' },
    ])
  })

  it('D. missing incoming label — existing beat preserved, drift log with write_accepted', async () => {
    const existingBeats = [
      beat('Opening', 0, 5),
      beat('Midpoint', 30, 6),
      beat('Climax', 60, 9),
    ]
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce({
      id: 'g1',
      filmId: 'film-1',
      dataPoints: existingBeats,
    })

    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')
    // Midpoint is missing from incoming → should be preserved from existing.
    const incoming = [beat('Opening', 0, 6), beat('Climax', 60, 8.5)]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: {},
      callerPath: 'review-blender',
    })

    expect(result.status).toBe('written')
    expect(result.droppedIncomingLabels).toEqual([])
    expect(result.preservedExistingLabels).toEqual(['Midpoint'])

    const merged = capturedDataPoints()
    expect(merged.map((b) => b.label)).toEqual(['Opening', 'Midpoint', 'Climax'])
    // Midpoint retains its prior score because no incoming beat matched it.
    expect(merged[1]).toEqual(existingBeats[1])
    expect(merged[0].score).toBe(6)
    expect(merged[2].score).toBe(8.5)

    expect(mocks.tx.sentimentGraphDriftLog.create).toHaveBeenCalledTimes(1)
    const driftArg = mocks.tx.sentimentGraphDriftLog.create.mock.calls[0][0].data
    expect(driftArg.action).toBe('write_accepted')
    expect(driftArg.existingBeatCount).toBe(3)
    expect(driftArg.incomingBeatCount).toBe(2)
    expect(driftArg.mismatchedLabels).toEqual([
      { incoming: 'Midpoint', reason: 'missing_from_incoming' },
    ])
  })

  it('E. beat count differs (existing 12, incoming 10) — drift log written, merged has 12', async () => {
    const existingBeats = Array.from({ length: 12 }, (_, i) =>
      beat(`Beat${i + 1}`, i * 10, 5 + (i % 3))
    )
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce({
      id: 'g1',
      filmId: 'film-1',
      dataPoints: existingBeats,
    })

    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')
    // Incoming has 10 of the 12 labels (Beat3 + Beat11 are missing).
    const incomingLabels = existingBeats
      .map((b) => b.label)
      .filter((l) => l !== 'Beat3' && l !== 'Beat11')
    const incoming = incomingLabels.map((label, i) => beat(label, 999, i + 1))

    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: {},
      callerPath: 'cron-analyze',
    })

    expect(result.status).toBe('written')
    expect(result.droppedIncomingLabels).toEqual([])
    expect(result.preservedExistingLabels.sort()).toEqual(['Beat11', 'Beat3'])

    const merged = capturedDataPoints()
    expect(merged).toHaveLength(12)
    // Beat3 and Beat11 are preserved as-is (original score) because nothing
    // incoming matched them.
    const beat3 = merged.find((b) => b.label === 'Beat3')
    const beat11 = merged.find((b) => b.label === 'Beat11')
    expect(beat3).toEqual(existingBeats.find((b) => b.label === 'Beat3'))
    expect(beat11).toEqual(existingBeats.find((b) => b.label === 'Beat11'))

    expect(mocks.tx.sentimentGraphDriftLog.create).toHaveBeenCalledTimes(1)
    const driftArg = mocks.tx.sentimentGraphDriftLog.create.mock.calls[0][0].data
    expect(driftArg.existingBeatCount).toBe(12)
    expect(driftArg.incomingBeatCount).toBe(10)
    expect(driftArg.action).toBe('write_accepted')
  })

  it('F. env lock disabled — writes incoming as-is, pino.warn called, no drift log', async () => {
    process.env.SENTIMENT_BEAT_LOCK_ENABLED = 'false'

    const existingBeats = [beat('Opening', 0, 5)]
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce({
      id: 'g1',
      filmId: 'film-1',
      dataPoints: existingBeats,
    })

    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')
    // Incoming has a label the existing does not. With the lock enabled this
    // would be dropped; with the lock disabled it must be written verbatim.
    const incoming = [beat('Renamed Opening', 100, 9)]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: { overallScore: 9 },
      callerPath: 'admin-analyze',
    })

    expect(result.status).toBe('written')
    expect(result.droppedIncomingLabels).toEqual([])
    expect(result.preservedExistingLabels).toEqual([])

    const merged = capturedDataPoints()
    expect(merged).toEqual(incoming)

    expect(mocks.tx.sentimentGraphDriftLog.create).not.toHaveBeenCalled()

    // A loud warn records the fact that the lock was explicitly off.
    expect(mocks.childLogger.warn).toHaveBeenCalled()
    const warnCall = mocks.childLogger.warn.mock.calls[0]
    expect(warnCall[0]).toMatchObject({
      filmId: 'film-1',
      callerPath: 'admin-analyze',
      envLockEnabled: false,
    })
  })

  it('I. case-sensitive label match — different casing is treated as different label', async () => {
    const existingBeats = [beat('The Opening', 0, 5)]
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce({
      id: 'g1',
      filmId: 'film-1',
      dataPoints: existingBeats,
    })

    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')
    const incoming = [beat('The opening', 0, 9)]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: {},
      callerPath: 'cron-analyze',
    })

    expect(result.status).toBe('written_with_drops')
    expect(result.droppedIncomingLabels).toEqual(['The opening'])
    expect(result.preservedExistingLabels).toEqual(['The Opening'])

    // Merged result keeps existing label + existing score; incoming is dropped.
    const merged = capturedDataPoints()
    expect(merged).toEqual(existingBeats)

    expect(mocks.tx.sentimentGraphDriftLog.create).toHaveBeenCalledTimes(1)
    const driftArg = mocks.tx.sentimentGraphDriftLog.create.mock.calls[0][0].data
    expect(driftArg.action).toBe('write_accepted_with_drops')
    expect(driftArg.mismatchedLabels).toEqual(
      expect.arrayContaining([
        { incoming: 'The opening', reason: 'not_in_existing' },
        { incoming: 'The Opening', reason: 'missing_from_incoming' },
      ])
    )
  })

  it('H. incoming tries to change a timestamp — merge preserves existing timestamp', async () => {
    const existingBeats = [
      {
        label: 'Opening',
        timeStart: 0,
        timeEnd: 10,
        timeMidpoint: 5,
        score: 5,
        confidence: 'medium' as const,
        reviewEvidence: 'original ev',
      },
    ]
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce({
      id: 'g1',
      filmId: 'film-1',
      dataPoints: existingBeats,
    })

    const { safeWriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')
    // Same label, but incoming is trying to move the beat to a new time window.
    const incoming: SentimentDataPoint[] = [
      {
        label: 'Opening',
        timeStart: 100,
        timeEnd: 200,
        timeMidpoint: 150,
        score: 9,
        confidence: 'high',
        reviewEvidence: 'new ev',
      },
    ]
    const result = await safeWriteSentimentGraph({
      filmId: 'film-1',
      incomingDataPoints: incoming,
      otherFields: {},
      callerPath: 'review-blender',
    })

    expect(result.status).toBe('written')

    const merged = capturedDataPoints()
    // Timestamps locked to existing values; score/confidence/evidence updated
    // from incoming.
    expect(merged).toEqual([
      {
        label: 'Opening',
        timeStart: 0,
        timeEnd: 10,
        timeMidpoint: 5,
        score: 9,
        confidence: 'high',
        reviewEvidence: 'new ev',
      },
    ])

    // Labels + count match, so timestamp-only divergence does not trigger a
    // drift log — the merge silently enforces the lock.
    expect(mocks.tx.sentimentGraphDriftLog.create).not.toHaveBeenCalled()
  })
})

describe('forceOverwriteSentimentGraph', () => {
  beforeEach(() => {
    resetMocks()
    delete process.env.SENTIMENT_BEAT_LOCK_ENABLED
  })

  it('G. force overwrite — writes incoming as-is, pino.warn logged, no drift log', async () => {
    // Force-overwrite does not read existing beats for merging — but does use
    // findUnique to decide create vs update. Simulate an existing row.
    mocks.tx.sentimentGraph.findUnique.mockResolvedValueOnce({
      id: 'g1',
      filmId: 'film-1',
      dataPoints: [beat('Whatever', 0, 3)],
    })

    const { forceOverwriteSentimentGraph } = await import('@/lib/sentiment-beat-lock')
    const incoming = [beat('Brand New Label', 0, 5), beat('Another', 30, 7)]
    await forceOverwriteSentimentGraph({
      filmId: 'film-1',
      dataPoints: incoming,
      otherFields: { overallScore: 6, anchoredFrom: 'omdb' },
      callerPath: 'script-backfill-wikipedia-beats',
    })

    // Written as-is, no merging.
    expect(mocks.tx.sentimentGraph.update).toHaveBeenCalledTimes(1)
    expect(capturedDataPoints()).toEqual(incoming)

    // No drift log — force overwrite is intentional, not drift.
    expect(mocks.tx.sentimentGraphDriftLog.create).not.toHaveBeenCalled()

    // Loud warn on every call.
    expect(mocks.childLogger.warn).toHaveBeenCalled()
    const warnCall = mocks.childLogger.warn.mock.calls[0]
    expect(warnCall[0]).toMatchObject({
      filmId: 'film-1',
      callerPath: 'script-backfill-wikipedia-beats',
      event: 'force_overwrite',
    })

    // Row-level lock is still taken so force-overwrite doesn't race.
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1)
  })
})

describe('isBeatLockEnabled', () => {
  afterEach(() => {
    delete process.env.SENTIMENT_BEAT_LOCK_ENABLED
  })

  it('defaults to true when unset', async () => {
    delete process.env.SENTIMENT_BEAT_LOCK_ENABLED
    const { isBeatLockEnabled } = await import('@/lib/sentiment-beat-lock')
    expect(isBeatLockEnabled()).toBe(true)
  })

  it('returns false only for the exact string "false"', async () => {
    const { isBeatLockEnabled } = await import('@/lib/sentiment-beat-lock')

    process.env.SENTIMENT_BEAT_LOCK_ENABLED = 'false'
    expect(isBeatLockEnabled()).toBe(false)

    // Any other value fails safe → locked.
    process.env.SENTIMENT_BEAT_LOCK_ENABLED = 'FALSE'
    expect(isBeatLockEnabled()).toBe(true)

    process.env.SENTIMENT_BEAT_LOCK_ENABLED = '0'
    expect(isBeatLockEnabled()).toBe(true)

    process.env.SENTIMENT_BEAT_LOCK_ENABLED = 'true'
    expect(isBeatLockEnabled()).toBe(true)

    process.env.SENTIMENT_BEAT_LOCK_ENABLED = ''
    expect(isBeatLockEnabled()).toBe(true)
  })
})
