import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HybridResult } from '@/lib/hybrid-sentiment'
import type { SentimentDataPoint } from '@/lib/types'

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// The wrapper (generateHybridAndStore) orchestrates several other helpers.
// We mock each at the module boundary so the test exercises only the wrapper
// itself — threshold check, hash check, and the adapter layer between
// HybridResult and safeWriteSentimentGraph.
//
// vi.mock() is hoisted above any top-level `const` in the file. Referencing a
// plain top-level variable from inside a vi.mock() factory therefore reads
// `undefined` at mock-setup time. vi.hoisted() lifts these references above
// the hoisted mocks so the factories see the real vi.fn() stubs.

const mocks = vi.hoisted(() => ({
  prisma: {
    film: { findUnique: vi.fn(), update: vi.fn() },
    review: { findMany: vi.fn() },
  },
  fetchAllReviews: vi.fn(),
  computeReviewHash: vi.fn(),
  fetchAnchorScores: vi.fn(),
  generateHybridSentimentGraph: vi.fn(),
  safeWriteSentimentGraph: vi.fn(),
  forceOverwriteSentimentGraph: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  pipelineLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  reviewLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))

vi.mock('@/lib/review-fetcher', () => ({
  fetchAllReviews: mocks.fetchAllReviews,
  computeReviewHash: mocks.computeReviewHash,
}))

vi.mock('@/lib/omdb', () => ({
  fetchAnchorScores: mocks.fetchAnchorScores,
}))

vi.mock('@/lib/hybrid-sentiment', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hybrid-sentiment')>(
    '@/lib/hybrid-sentiment'
  )
  return {
    ...actual,
    generateHybridSentimentGraph: mocks.generateHybridSentimentGraph,
  }
})

vi.mock('@/lib/sentiment-beat-lock', () => ({
  safeWriteSentimentGraph: mocks.safeWriteSentimentGraph,
  forceOverwriteSentimentGraph: mocks.forceOverwriteSentimentGraph,
  isBeatLockEnabled: () => true,
  beatLockLogger: { warn: vi.fn(), info: vi.fn() },
}))

// Heavy dependency pulled in transitively by sentiment-pipeline.ts — mock to
// avoid evaluating the real claude module.
vi.mock('@/lib/claude', () => ({
  analyzeSentiment: vi.fn(),
  buildAnalysisPromptParts: vi.fn(),
}))

vi.mock('@/lib/sources/wikipedia', () => ({
  fetchWikipediaPlot: vi.fn(),
}))

// ── Test fixtures ───────────────────────────────────────────────────────────

// isQualityReview requires >= 50 words of predominantly English characters.
const QUALITY_TEXT =
  'This film is a masterful exploration of memory and loss that unfolds with ' +
  'remarkable restraint. The direction patiently builds tension while the ' +
  'performances ground every emotional beat in lived specificity. The ' +
  'cinematography frames each scene with care and the soundtrack underscores ' +
  'the emotional weight without ever veering into melodrama. Every supporting ' +
  'character earns their screen time, and the film rewards careful attention ' +
  'with a structure that rhymes rather than repeats.'

function qualityReview(i: number) {
  return {
    id: `r${i}`,
    filmId: 'film-1',
    sourcePlatform: 'TMDB' as const,
    author: `author ${i}`,
    reviewText: QUALITY_TEXT,
    sourceRating: 8,
    contentHash: `hash-${i}`,
    fetchedAt: new Date(),
  }
}

function fakeFilm(overrides: Record<string, unknown> = {}) {
  return {
    id: 'film-1',
    title: 'Test Film',
    tmdbId: 12345,
    imdbId: 'tt1234567',
    releaseDate: new Date('2020-01-01'),
    runtime: 120,
    director: 'A Director',
    genres: ['Drama'],
    imdbRating: 7.5,
    rtCriticsScore: 80,
    rtAudienceScore: 85,
    metacriticScore: 75,
    synopsis: null,
    lastReviewCount: 0,
    status: 'ACTIVE',
    ...overrides,
  }
}

function fakeBeats(): SentimentDataPoint[] {
  return [
    {
      label: 'Opening',
      labelFull: 'The opening scene introduces the protagonist',
      timeStart: 0,
      timeEnd: 10,
      timeMidpoint: 5,
      score: 7,
      confidence: 'high',
      reviewEvidence: 'evidence',
    },
    {
      label: 'Climax',
      labelFull: 'The climactic confrontation',
      timeStart: 60,
      timeEnd: 80,
      timeMidpoint: 70,
      score: 9,
      confidence: 'high',
      reviewEvidence: 'evidence',
    },
  ]
}

function fakeHybridResult(overrides: Partial<HybridResult> = {}): HybridResult {
  return {
    filmId: 'film-1',
    filmTitle: 'Test Film',
    runtime: 120,
    reviewCount: 5,
    wikipediaPlotAvailable: true,
    wikipediaPlotLength: 2000,
    beats: fakeBeats(),
    overallScore: 7.8,
    peakMoment: { label: 'Climax', labelFull: 'The climactic confrontation', score: 9, time: 70 },
    lowestMoment: { label: 'Opening', labelFull: 'The opening scene introduces the protagonist', score: 7, time: 5 },
    biggestSentimentSwing: 'A notable swing',
    summary: 'A summary',
    generationMode: 'hybrid',
    durationMs: 1000,
    tokenUsage: { input: 1000, output: 500 },
    prompt: { system: null, user: 'test' },
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('generateHybridAndStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchAllReviews.mockResolvedValue(0)
    mocks.fetchAnchorScores.mockResolvedValue({
      imdbRating: 7.5,
      rtCriticsScore: 80,
      rtAudienceScore: 85,
      metacriticScore: 75,
    })
    mocks.safeWriteSentimentGraph.mockResolvedValue({
      status: 'written',
      acceptedBeatCount: 2,
      droppedIncomingLabels: [],
      preservedExistingLabels: [],
    })
    mocks.prisma.film.update.mockResolvedValue({})
  })

  it('first-write path: persists HybridResult via safeWriteSentimentGraph when no graph exists', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({
      ...fakeFilm(),
      sentimentGraph: null,
    })
    mocks.prisma.review.findMany.mockResolvedValue([
      qualityReview(1),
      qualityReview(2),
      qualityReview(3),
      qualityReview(4),
    ])
    mocks.computeReviewHash.mockReturnValue('new-hash')
    mocks.generateHybridSentimentGraph.mockResolvedValue(fakeHybridResult())

    const { generateHybridAndStore } = await import('@/lib/sentiment-pipeline')
    const result = await generateHybridAndStore('film-1', {
      force: false,
      callerPath: 'admin-analyze',
    })

    expect(mocks.generateHybridSentimentGraph).toHaveBeenCalledWith('film-1')
    expect(mocks.safeWriteSentimentGraph).toHaveBeenCalledTimes(1)
    expect(mocks.forceOverwriteSentimentGraph).not.toHaveBeenCalled()

    const writeArgs = mocks.safeWriteSentimentGraph.mock.calls[0][0]
    expect(writeArgs.filmId).toBe('film-1')
    expect(writeArgs.callerPath).toBe('admin-analyze')
    expect(writeArgs.incomingDataPoints).toEqual(fakeBeats())
    expect(writeArgs.otherFields.overallScore).toBe(7.8)
    expect(writeArgs.otherFields.previousScore).toBeNull()
    expect(writeArgs.otherFields.version).toBe(1)
    expect(writeArgs.otherFields.reviewHash).toBe('new-hash')
    expect(writeArgs.otherFields.varianceSource).toBe('external_only')
    expect(writeArgs.otherFields.biggestSwing).toBe('A notable swing')
    expect(result.status).toBe('generated')
    if (result.status === 'generated') {
      expect(result.beatCount).toBe(2)
      expect(result.generationMode).toBe('hybrid')
    }
  })

  it('merge path: passes incoming beats to safeWriteSentimentGraph when an existing graph is present', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({
      ...fakeFilm(),
      sentimentGraph: {
        id: 'graph-1',
        reviewHash: 'old-hash',
        overallScore: 6.5,
        version: 3,
      },
    })
    mocks.prisma.review.findMany.mockResolvedValue([
      qualityReview(1),
      qualityReview(2),
      qualityReview(3),
    ])
    mocks.computeReviewHash.mockReturnValue('fresh-hash')
    mocks.generateHybridSentimentGraph.mockResolvedValue(fakeHybridResult())

    const { generateHybridAndStore } = await import('@/lib/sentiment-pipeline')
    await generateHybridAndStore('film-1', {
      force: true,
      callerPath: 'admin-analyze',
    })

    expect(mocks.safeWriteSentimentGraph).toHaveBeenCalledTimes(1)
    const writeArgs = mocks.safeWriteSentimentGraph.mock.calls[0][0]
    // Wrapper passes incoming beats; the label-preservation merge itself is
    // owned by safeWriteSentimentGraph (verified by integration tests).
    expect(writeArgs.incomingDataPoints).toEqual(fakeBeats())
    // previousScore and version chained off the existing row.
    expect(writeArgs.otherFields.previousScore).toBe(6.5)
    expect(writeArgs.otherFields.version).toBe(4)
    expect(mocks.forceOverwriteSentimentGraph).not.toHaveBeenCalled()
  })

  it('rejects films with fewer than MIN_QUALITY_REVIEWS_FOR_GENERATION quality reviews', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({
      ...fakeFilm(),
      sentimentGraph: null,
    })
    mocks.prisma.review.findMany.mockResolvedValue([qualityReview(1), qualityReview(2)])

    const { generateHybridAndStore } = await import('@/lib/sentiment-pipeline')
    await expect(
      generateHybridAndStore('film-1', { force: true, callerPath: 'admin-analyze' })
    ).rejects.toThrow(/Insufficient quality reviews/)

    expect(mocks.generateHybridSentimentGraph).not.toHaveBeenCalled()
    expect(mocks.safeWriteSentimentGraph).not.toHaveBeenCalled()
  })

  it('force: true bypasses the review-hash skip', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({
      ...fakeFilm(),
      sentimentGraph: {
        id: 'graph-1',
        reviewHash: 'matching-hash',
        overallScore: 7,
        version: 2,
      },
    })
    mocks.prisma.review.findMany.mockResolvedValue([
      qualityReview(1),
      qualityReview(2),
      qualityReview(3),
    ])
    // Hash matches existing — without force, this would skip.
    mocks.computeReviewHash.mockReturnValue('matching-hash')
    mocks.generateHybridSentimentGraph.mockResolvedValue(fakeHybridResult())

    const { generateHybridAndStore } = await import('@/lib/sentiment-pipeline')

    // Without force: should skip (sanity check).
    const skipped = await generateHybridAndStore('film-1', {
      force: false,
      callerPath: 'admin-analyze',
    })
    expect(skipped.status).toBe('skipped_unchanged')
    expect(mocks.generateHybridSentimentGraph).not.toHaveBeenCalled()
    expect(mocks.safeWriteSentimentGraph).not.toHaveBeenCalled()

    // With force: should proceed all the way through.
    const generated = await generateHybridAndStore('film-1', {
      force: true,
      callerPath: 'admin-analyze',
    })
    expect(generated.status).toBe('generated')
    expect(mocks.generateHybridSentimentGraph).toHaveBeenCalledWith('film-1')
    expect(mocks.safeWriteSentimentGraph).toHaveBeenCalledTimes(1)
  })
})
