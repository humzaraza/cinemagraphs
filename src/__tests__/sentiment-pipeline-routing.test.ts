import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Film } from '@/generated/prisma/client'
import type { SentimentGraphData } from '@/lib/types'
import type { BeatLockCallerPath } from '@/lib/sentiment-beat-lock'
import type { SentimentGraphInput } from '@/lib/sentiment-pipeline'

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// storeSentimentGraphResult reads the existing graph row (to decide version +
// previousScore), routes the actual write through the beat-lock module, then
// updates the film's lastReviewCount. We mock prisma + the beat-lock module
// so we can assert which write path was chosen.

const mockSentimentGraphFindUnique = vi.fn()
const mockFilmUpdate = vi.fn()
const mockSafeWrite = vi.fn()
const mockForceOverwrite = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    sentimentGraph: {
      findUnique: (...args: unknown[]) => mockSentimentGraphFindUnique(...args),
    },
    film: {
      update: (...args: unknown[]) => mockFilmUpdate(...args),
    },
  },
}))

vi.mock('@/lib/sentiment-beat-lock', async () => {
  // Keep the real `BeatLockCallerPath` type export intact; only the two write
  // helpers need to be spied on.
  const actual =
    await vi.importActual<typeof import('@/lib/sentiment-beat-lock')>('@/lib/sentiment-beat-lock')
  return {
    ...actual,
    safeWriteSentimentGraph: (...args: unknown[]) => mockSafeWrite(...args),
    forceOverwriteSentimentGraph: (...args: unknown[]) => mockForceOverwrite(...args),
  }
})

vi.mock('@/lib/logger', () => {
  const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    pipelineLogger: stub,
    logger: { child: vi.fn(() => stub), ...stub },
  }
})

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeInput(): SentimentGraphInput {
  const film = {
    id: 'film-1',
    title: 'Test Film',
  } as unknown as Film

  return {
    film,
    reviews: [],
    filteredReviewCount: 5,
    anchorScores: {
      imdbRating: null,
      rtCriticsScore: null,
      rtAudienceScore: null,
      metacriticScore: null,
    },
    plotContext: { text: '', source: 'reviews_only' },
    reviewHash: 'hash-xyz',
    promptParts: { system: '', user: '' },
  }
}

function makeGraphData(): SentimentGraphData {
  return {
    film: 'Test Film',
    anchoredFrom: 'imdb',
    dataPoints: [
      {
        label: 'Opening',
        timeStart: 0,
        timeEnd: 10,
        timeMidpoint: 5,
        score: 6,
        confidence: 'medium',
        reviewEvidence: 'ev',
      },
    ],
    overallSentiment: 7,
    peakMoment: { label: 'Opening', score: 6, time: 5 },
    lowestMoment: { label: 'Opening', score: 6, time: 5 },
    biggestSentimentSwing: 'n/a',
    summary: 'A film.',
    sources: ['tmdb'],
    varianceSource: 'external_only',
    reviewCount: 5,
    generatedAt: new Date().toISOString(),
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('storeSentimentGraphResult routing', () => {
  beforeEach(() => {
    mockSentimentGraphFindUnique.mockReset()
    mockFilmUpdate.mockReset()
    mockSafeWrite.mockReset()
    mockForceOverwrite.mockReset()

    mockSentimentGraphFindUnique.mockResolvedValue(null)
    mockFilmUpdate.mockResolvedValue({})
    mockSafeWrite.mockResolvedValue({
      status: 'written',
      acceptedBeatCount: 1,
      droppedIncomingLabels: [],
      preservedExistingLabels: [],
    })
    mockForceOverwrite.mockResolvedValue(undefined)
  })

  it('default (no forceOverwrite) routes through safeWriteSentimentGraph', async () => {
    const { storeSentimentGraphResult } = await import('@/lib/sentiment-pipeline')
    await storeSentimentGraphResult(makeInput(), makeGraphData(), 'cron-analyze')

    expect(mockSafeWrite).toHaveBeenCalledTimes(1)
    expect(mockForceOverwrite).not.toHaveBeenCalled()

    const args = mockSafeWrite.mock.calls[0][0]
    expect(args.filmId).toBe('film-1')
    expect(args.callerPath).toBe('cron-analyze')
    expect(args.incomingDataPoints).toHaveLength(1)
  })

  it('forceOverwrite: false routes through safeWriteSentimentGraph', async () => {
    const { storeSentimentGraphResult } = await import('@/lib/sentiment-pipeline')
    await storeSentimentGraphResult(
      makeInput(),
      makeGraphData(),
      'user-submission',
      { forceOverwrite: false }
    )

    expect(mockSafeWrite).toHaveBeenCalledTimes(1)
    expect(mockForceOverwrite).not.toHaveBeenCalled()
    expect(mockSafeWrite.mock.calls[0][0].callerPath).toBe('user-submission')
  })

  it('forceOverwrite: true routes through forceOverwriteSentimentGraph', async () => {
    const { storeSentimentGraphResult } = await import('@/lib/sentiment-pipeline')
    await storeSentimentGraphResult(
      makeInput(),
      makeGraphData(),
      'admin-analyze',
      { forceOverwrite: true }
    )

    expect(mockForceOverwrite).toHaveBeenCalledTimes(1)
    expect(mockSafeWrite).not.toHaveBeenCalled()

    const args = mockForceOverwrite.mock.calls[0][0]
    expect(args.filmId).toBe('film-1')
    expect(args.callerPath).toBe('admin-analyze')
    expect(args.dataPoints).toHaveLength(1)
  })

  it('still updates lastReviewCount on the film regardless of which write path is used', async () => {
    const { storeSentimentGraphResult } = await import('@/lib/sentiment-pipeline')
    await storeSentimentGraphResult(
      makeInput(),
      makeGraphData(),
      'admin-analyze',
      { forceOverwrite: true }
    )

    expect(mockFilmUpdate).toHaveBeenCalledWith({
      where: { id: 'film-1' },
      data: { lastReviewCount: 5 },
    })
  })
})

describe('BeatLockCallerPath union', () => {
  // These are type-level assertions: if the union didn't accept the literal,
  // the file would fail to compile. The runtime `expect` calls just keep the
  // test file executing and the assertion visible in the test report.

  it("accepts 'user-submission' as a valid caller path", () => {
    const caller: BeatLockCallerPath = 'user-submission'
    expect(caller).toBe('user-submission')
  })

  it("accepts 'script-diagnose-film' as a valid caller path", () => {
    const caller: BeatLockCallerPath = 'script-diagnose-film'
    expect(caller).toBe('script-diagnose-film')
  })

  it('still accepts the pre-existing caller paths', () => {
    const paths: BeatLockCallerPath[] = [
      'review-blender',
      'cron-analyze',
      'cron-refresh-scores',
      'admin-analyze',
      'script-batch-analyze',
      'script-test-pipeline',
      'script-backfill-wikipedia-beats',
      'test',
    ]
    expect(paths).toHaveLength(8)
  })
})
