import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Film } from '@/generated/prisma/client'

// ── Guards under test ────────────────────────────────────────────────────────
//
// 1. Mean-vs-score: the mean of dataPoints[].score must sit within 0.2 of the
//    graph's own overallSentiment. Outside that the result is REJECTED (thrown),
//    never rounded, clamped, or written with a warning.
// 2. Runtime: film.runtime must be > 0. Runtime is stored as 0 (not null) for
//    many rows, so a null check is not enough, and there is no 120 fallback.
//
// Both rules are enforced at every entry point: parseGraphResponse (claude.ts,
// driven here through fetchBatchResults), validateGraph (hybrid-sentiment.ts),
// buildAnalysisPromptParts (classic prompt), generateHybridSentimentGraph.

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  batchesResults: vi.fn(),
  fetchWikipediaPlot: vi.fn(),
  isQualityReview: vi.fn(() => true),
  prisma: {
    film: { findUnique: vi.fn() },
    review: { findMany: vi.fn() },
  },
}))

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: (...args: unknown[]) => mocks.messagesCreate(...args),
      batches: {
        create: vi.fn(),
        retrieve: vi.fn(),
        results: (...args: unknown[]) => mocks.batchesResults(...args),
      },
    }
  }
  return { default: MockAnthropic }
})

vi.mock('@/lib/logger', () => ({
  pipelineLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/sources/wikipedia', () => ({ fetchWikipediaPlot: mocks.fetchWikipediaPlot }))
vi.mock('@/lib/sentiment-pipeline', () => ({ isQualityReview: mocks.isQualityReview }))

function beats(scores: number[]) {
  return scores.map((score, i) => ({
    timeStart: i * 8,
    timeEnd: (i + 1) * 8,
    timeMidpoint: i * 8 + 4,
    score,
    label: `Segment ${i + 1}`,
    labelFull: `Descriptive Segment ${i + 1} with specific event`,
    confidence: 'medium',
    reviewEvidence: 'Reviewers liked this section.',
  }))
}

function graphObject(scores: number[], overallSentiment: number) {
  return {
    film: 'Test Film',
    anchoredFrom: 'IMDb 7.5',
    dataPoints: beats(scores) as Array<Record<string, unknown>>,
    overallSentiment,
    peakMoment: { label: 'High', labelFull: 'High point where reviewers cheered', score: 9, time: 60 },
    lowestMoment: { label: 'Low', labelFull: 'Low point where reviewers disengaged', score: 5, time: 20 },
    biggestSentimentSwing: 'Mid-film tonal shift',
    summary: 'A solid run with a strong middle.',
    sources: ['tmdb'],
    varianceSource: 'external_only',
    reviewCount: 12,
    generatedAt: '2024-01-01T00:00:00Z',
  }
}

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item
    },
  }
}

function batchEntry(text: string) {
  return {
    custom_id: 'film-1',
    result: {
      type: 'succeeded',
      message: {
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  }
}

function film(overrides: Partial<Film> = {}): Film {
  return {
    id: 'film-1',
    tmdbId: 1,
    imdbId: 'tt0000001',
    title: 'Test Film',
    releaseDate: new Date('2010-01-01'),
    runtime: 95,
    synopsis: null,
    posterUrl: null,
    backdropUrl: null,
    genres: ['Drama'],
    director: 'Someone',
    cast: null,
    imdbRating: 7.4,
    imdbVotes: 1000,
    rtCriticsScore: null,
    rtAudienceScore: null,
    metacriticScore: null,
    keywords: [],
    originalLanguage: 'en',
    originCountries: [],
    lastReviewCount: 0,
    nowPlaying: false,
    nowPlayingOverride: null,
    tickerOverride: null,
    addedByUserId: null,
    isFeatured: false,
    pinnedSection: null,
    status: 'ACTIVE',
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-01'),
    ...overrides,
  } as Film
}

const twelveSevens = Array.from({ length: 12 }, () => 7)

describe('assertMeanWithinTolerance', () => {
  it('accepts a mean inside the 0.2 window', async () => {
    const { assertMeanWithinTolerance } = await import('@/lib/claude')
    expect(() => assertMeanWithinTolerance(beats(twelveSevens), 7)).not.toThrow()
    expect(() => assertMeanWithinTolerance(beats(twelveSevens), 7.19)).not.toThrow()
    expect(() => assertMeanWithinTolerance(beats(twelveSevens), 6.81)).not.toThrow()
  })

  it('accepts a gap of exactly 0.2 despite floating-point noise', async () => {
    const { assertMeanWithinTolerance } = await import('@/lib/claude')
    // 7.2 - 7 evaluates to 0.20000000000000018 in IEEE-754.
    expect(() => assertMeanWithinTolerance(beats(twelveSevens), 7.2)).not.toThrow()
    expect(() => assertMeanWithinTolerance(beats(twelveSevens), 6.8)).not.toThrow()
  })

  it('rejects a gap just over 0.2 in either direction', async () => {
    const { assertMeanWithinTolerance } = await import('@/lib/claude')
    expect(() => assertMeanWithinTolerance(beats(twelveSevens), 7.21)).toThrow(/Beat mean/)
    expect(() => assertMeanWithinTolerance(beats(twelveSevens), 6.79)).toThrow(/Beat mean/)
    // A large gap that the old code would have written unchanged.
    expect(() => assertMeanWithinTolerance(beats(twelveSevens), 8.5)).toThrow(/1\.500 from overallSentiment 8\.5/)
  })

  it('rejects when any score is not a finite number instead of letting NaN pass', async () => {
    const { assertMeanWithinTolerance } = await import('@/lib/claude')
    const withString = beats(twelveSevens) as Array<{ score: unknown }>
    withString[3].score = '7'
    expect(() => assertMeanWithinTolerance(withString, 7)).toThrow(/dataPoints\[3\]\.score/)
    const withNaN = beats(twelveSevens) as Array<{ score: unknown }>
    withNaN[0].score = Number.NaN
    expect(() => assertMeanWithinTolerance(withNaN, 7)).toThrow(/dataPoints\[0\]\.score/)
    expect(() => assertMeanWithinTolerance(beats(twelveSevens), Number.NaN)).toThrow(/overallSentiment/)
  })
})

describe('overallScoreFromBeats', () => {
  it('is the mean of the beat scores rounded to one decimal', async () => {
    const { overallScoreFromBeats } = await import('@/lib/claude')
    expect(overallScoreFromBeats(beats(twelveSevens))).toBe(7)
    // 6, 5.5, 9 average 6.8333 -> 6.8
    expect(overallScoreFromBeats(beats([6, 5.5, 9]))).toBe(6.8)
    // 7, 7.5 average 7.25 -> 7.3 (half rounds up)
    expect(overallScoreFromBeats(beats([7, 7.5]))).toBe(7.3)
  })

  it('refuses a non-numeric score rather than averaging around it', async () => {
    const { overallScoreFromBeats } = await import('@/lib/claude')
    const bad = beats([7, 7]) as Array<{ score: unknown }>
    bad[1].score = '7'
    expect(() => overallScoreFromBeats(bad)).toThrow(/dataPoints\[1\]\.score/)
  })
})

describe('validateGraph (hybrid-sentiment.ts)', () => {
  it('derives overallSentiment from the beats', async () => {
    const { validateGraph } = await import('@/lib/hybrid-sentiment')
    const g = graphObject([6, 7, 8, 6, 7, 8, 6, 7, 8, 6, 7, 8], 7)
    expect(validateGraph(g).overallSentiment).toBe(7)
  })

  it('ignores whatever overallSentiment the model emitted', async () => {
    const { validateGraph } = await import('@/lib/hybrid-sentiment')
    // Beats average 7.0 while the model claimed 7.5: the model's number is
    // discarded, not validated against.
    const g = graphObject(twelveSevens, 7.5)
    expect(validateGraph(g).overallSentiment).toBe(7)
    // A missing value is fine too; nothing is required from the model here.
    const noHeadline = graphObject(twelveSevens, 7.5) as Record<string, unknown>
    delete noHeadline.overallSentiment
    expect(validateGraph(noHeadline).overallSentiment).toBe(7)
  })
})

describe('parseGraphResponse via fetchBatchResults (claude.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('succeeds and replaces the model headline with the beat mean', async () => {
    mocks.batchesResults.mockResolvedValueOnce(
      asyncIter([batchEntry(JSON.stringify(graphObject(twelveSevens, 7.5)))])
    )
    const { fetchBatchResults } = await import('@/lib/claude')
    const results = await fetchBatchResults('batch_abc', new Map())
    expect(results).toHaveLength(1)
    expect(results[0].outcome).toBe('succeeded')
    expect(results[0].data?.overallSentiment).toBe(7)
  })

  it('rounds the derived headline to one decimal', async () => {
    const scores = [6, 5.5, 9, 6, 5.5, 9, 6, 5.5, 9, 6, 5.5, 9] // mean 6.8333
    mocks.batchesResults.mockResolvedValueOnce(
      asyncIter([batchEntry(JSON.stringify(graphObject(scores, 9.9)))])
    )
    const { fetchBatchResults } = await import('@/lib/claude')
    const results = await fetchBatchResults('batch_abc', new Map())
    expect(results[0].outcome).toBe('succeeded')
    expect(results[0].data?.overallSentiment).toBe(6.8)
  })
})

describe('prompts carry no external rating target', () => {
  it('review-only prompt omits IMDb, target, and tolerance language', async () => {
    const { buildAnalysisPromptParts, SENTIMENT_SYSTEM_PROMPT } = await import('@/lib/claude')
    const parts = buildAnalysisPromptParts(film({ runtime: 95, imdbRating: 7.4 }), [])
    for (const text of [parts.user, SENTIMENT_SYSTEM_PROMPT]) {
      expect(text).not.toMatch(/IMDb/)
      expect(text).not.toMatch(/Target overall/)
      expect(text).not.toMatch(/±0\.2/)
      expect(text).not.toMatch(/anchoredFrom/)
      expect(text).not.toMatch(/"overallSentiment"/)
    }
  })

  it('hybrid prompt omits IMDb, target, and tolerance language', async () => {
    const { buildHybridPrompt } = await import('@/lib/hybrid-sentiment')
    const user = buildHybridPrompt({
      film: film({ runtime: 95, imdbRating: 7.4 }),
      year: 2010,
      runtime: 95,
      plotText: 'A plot.',
      reviews: [],
      beatCount: 10,
    })
    expect(user).not.toMatch(/IMDb/)
    expect(user).not.toMatch(/Target overall/)
    expect(user).not.toMatch(/±0\.2/)
    expect(user).not.toMatch(/anchoredFrom/)
    expect(user).not.toMatch(/"overallSentiment"/)
  })
})

describe('requireFilmRuntime', () => {
  it('returns a positive runtime', async () => {
    const { requireFilmRuntime } = await import('@/lib/claude')
    expect(requireFilmRuntime(film({ runtime: 95 }))).toBe(95)
  })

  it.each([
    ['zero (how missing runtimes are actually stored)', 0],
    ['null', null],
    ['negative', -10],
  ])('throws for %s and never falls back to 120', async (_label, runtime) => {
    const { requireFilmRuntime } = await import('@/lib/claude')
    expect(() => requireFilmRuntime(film({ runtime }))).toThrow(/no usable runtime/)
  })
})

describe('buildAnalysisPromptParts runtime guard', () => {
  it('uses the real runtime when present', async () => {
    const { buildAnalysisPromptParts } = await import('@/lib/claude')
    const parts = buildAnalysisPromptParts(film({ runtime: 95 }), [])
    expect(parts.user).toContain('95-minute runtime')
    expect(parts.user).not.toContain('120-minute')
  })

  it('throws for runtime 0 instead of building a 120-minute prompt', async () => {
    const { buildAnalysisPromptParts } = await import('@/lib/claude')
    expect(() =>
      buildAnalysisPromptParts(film({ runtime: 0 }), [])
    ).toThrow(/no usable runtime \(stored 0\)/)
  })
})

describe('generateHybridSentimentGraph runtime guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isQualityReview.mockReturnValue(true)
    mocks.prisma.review.findMany.mockResolvedValue([
      { id: 'r1', filmId: 'film-1', sourcePlatform: 'tmdb', reviewText: 'a'.repeat(400), sourceRating: 8, author: 'A' },
      { id: 'r2', filmId: 'film-1', sourcePlatform: 'tmdb', reviewText: 'b'.repeat(400), sourceRating: 7, author: 'B' },
      { id: 'r3', filmId: 'film-1', sourcePlatform: 'imdb', reviewText: 'c'.repeat(400), sourceRating: 6, author: 'C' },
    ])
  })

  it('throws before fetching a plot or calling Claude when runtime is 0', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(film({ runtime: 0 }))
    const { generateHybridSentimentGraph } = await import('@/lib/hybrid-sentiment')
    await expect(generateHybridSentimentGraph('film-1')).rejects.toThrow(/no usable runtime \(stored 0\)/)
    expect(mocks.fetchWikipediaPlot).not.toHaveBeenCalled()
    expect(mocks.messagesCreate).not.toHaveBeenCalled()
  })

  it('throws for a null runtime as well', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(film({ runtime: null }))
    const { generateHybridSentimentGraph } = await import('@/lib/hybrid-sentiment')
    await expect(generateHybridSentimentGraph('film-1')).rejects.toThrow(/no usable runtime \(stored null\)/)
    expect(mocks.messagesCreate).not.toHaveBeenCalled()
  })
})
