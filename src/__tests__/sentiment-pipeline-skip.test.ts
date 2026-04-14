import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// prepareSentimentGraphInput touches a lot of modules: prisma, the OMDB
// anchor-score fetcher, the review fetcher, the plot-context fallback chain,
// and the prompt builder. We mock them all so the test stays focused on the
// "should we skip vs proceed" decision logic.

const mockFilmFindUnique = vi.fn()
const mockFilmUpdate = vi.fn()
const mockReviewFindMany = vi.fn()
const mockSentimentGraphFindUnique = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    film: {
      findUnique: (...args: unknown[]) => mockFilmFindUnique(...args),
      update: (...args: unknown[]) => mockFilmUpdate(...args),
    },
    review: {
      findMany: (...args: unknown[]) => mockReviewFindMany(...args),
    },
    sentimentGraph: {
      findUnique: (...args: unknown[]) => mockSentimentGraphFindUnique(...args),
    },
  },
}))

const mockFetchAnchorScores = vi.fn()
vi.mock('@/lib/omdb', () => ({
  fetchAnchorScores: (...args: unknown[]) => mockFetchAnchorScores(...args),
}))

const mockFetchAllReviews = vi.fn()
vi.mock('@/lib/review-fetcher', async () => {
  // Keep the real computeReviewHash so the test's expected hash matches the
  // function used inside the pipeline.
  const actual =
    await vi.importActual<typeof import('@/lib/review-fetcher')>('@/lib/review-fetcher')
  return {
    ...actual,
    fetchAllReviews: (...args: unknown[]) => mockFetchAllReviews(...args),
  }
})

const mockFetchWikipediaPlot = vi.fn()
vi.mock('@/lib/sources/wikipedia', () => ({
  fetchWikipediaPlot: (...args: unknown[]) => mockFetchWikipediaPlot(...args),
}))

vi.mock('@/lib/logger', () => ({
  pipelineLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ── Fixtures ────────────────────────────────────────────────────────────────

const baseFilm = {
  id: 'film-1',
  tmdbId: 1234,
  title: 'Test Film',
  director: 'Someone',
  releaseDate: new Date('2020-01-01'),
  runtime: 120,
  genres: ['Drama'],
  imdbId: 'tt1234567',
  imdbRating: 7.5,
  rtCriticsScore: 80,
  rtAudienceScore: 85,
  metacriticScore: 75,
  synopsis: null,
  status: 'ACTIVE',
  lastReviewCount: 10,
}

function qualityReview(i: number, contentHash: string) {
  // 60-word string of ASCII chars, well above the 50-word quality threshold.
  const text = Array(60).fill(`word${i}`).join(' ')
  return {
    id: `r-${i}`,
    filmId: 'film-1',
    sourcePlatform: 'TMDB',
    sourceUrl: null,
    author: `Reviewer ${i}`,
    reviewText: text,
    sourceRating: 8,
    contentHash,
    fetchedAt: new Date(),
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// Hash that prepareSentimentGraphInput will compute for the canned 3-review set.
// It uses computeReviewHash internally — sorted contentHashes joined by '|',
// sha256.
const HASH_3_REVIEWS = sha(['hash-a', 'hash-b', 'hash-c'].sort().join('|'))

// ── Tests ───────────────────────────────────────────────────────────────────

describe('prepareSentimentGraphInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default OMDB call: nothing changed; pipeline still calls it.
    mockFetchAnchorScores.mockResolvedValue({
      imdbRating: null,
      rtCriticsScore: null,
      rtAudienceScore: null,
      metacriticScore: null,
    })
    // Default reviews fetcher: silent no-op, real reviews come from
    // mockReviewFindMany.
    mockFetchAllReviews.mockResolvedValue(undefined)
    // Default plot context: Wikipedia returns nothing (we don't care about
    // plot in skip-logic tests; reviews_only is fine).
    mockFetchWikipediaPlot.mockResolvedValue(null)
  })

  it('returns skipped_film_not_found when the film does not exist', async () => {
    mockFilmFindUnique.mockResolvedValueOnce(null)

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('missing')

    expect(result.status).toBe('skipped_film_not_found')
    // None of the downstream work should have run.
    expect(mockFetchAllReviews).not.toHaveBeenCalled()
    expect(mockReviewFindMany).not.toHaveBeenCalled()
  })

  it('returns skipped_insufficient_reviews when below the quality threshold', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      ...baseFilm,
      sentimentGraph: null,
    })
    // No quality reviews stored.
    mockReviewFindMany.mockResolvedValueOnce([])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1')

    expect(result.status).toBe('skipped_insufficient_reviews')
    if (result.status === 'skipped_insufficient_reviews') {
      expect(result.qualityCount).toBe(0)
      // 2020 release is older than 6 months → minRequired is 2.
      expect(result.minRequired).toBe(2)
    }
  })

  it('returns skipped_unchanged when the review hash matches the existing graph', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      ...baseFilm,
      sentimentGraph: { id: 'g1', reviewHash: HASH_3_REVIEWS },
    })
    mockReviewFindMany.mockResolvedValueOnce([
      qualityReview(1, 'hash-a'),
      qualityReview(2, 'hash-b'),
      qualityReview(3, 'hash-c'),
    ])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1')

    expect(result.status).toBe('skipped_unchanged')
    if (result.status === 'skipped_unchanged') {
      expect(result.reviewHash).toBe(HASH_3_REVIEWS)
      expect(result.filteredCount).toBe(3)
    }
    // We bailed out before reaching the plot-context fetch.
    expect(mockFetchWikipediaPlot).not.toHaveBeenCalled()
  })

  it('is order-insensitive: hash matches even when reviews come back in a different order', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      ...baseFilm,
      sentimentGraph: { id: 'g1', reviewHash: HASH_3_REVIEWS },
    })
    mockReviewFindMany.mockResolvedValueOnce([
      qualityReview(2, 'hash-c'),
      qualityReview(1, 'hash-a'),
      qualityReview(3, 'hash-b'),
    ])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1')

    expect(result.status).toBe('skipped_unchanged')
  })

  it('proceeds (status=ready) when hash differs from the existing graph', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      ...baseFilm,
      sentimentGraph: { id: 'g1', reviewHash: 'totally-different-hash' },
    })
    mockReviewFindMany.mockResolvedValueOnce([
      qualityReview(1, 'hash-a'),
      qualityReview(2, 'hash-b'),
      qualityReview(3, 'hash-c'),
    ])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1')

    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.input.reviewHash).toBe(HASH_3_REVIEWS)
      expect(result.input.filteredReviewCount).toBe(3)
      expect(result.input.reviews).toHaveLength(3)
      // Prompt parts get built so the cron can hand them to the Batch API.
      expect(result.input.promptParts.system).toContain('film sentiment analyst')
      expect(result.input.promptParts.user).toContain('Test Film')
    }
  })

  it('proceeds (status=ready) when no graph exists yet (first analysis)', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      ...baseFilm,
      sentimentGraph: null,
    })
    mockReviewFindMany.mockResolvedValueOnce([
      qualityReview(1, 'hash-a'),
      qualityReview(2, 'hash-b'),
      qualityReview(3, 'hash-c'),
    ])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1')

    expect(result.status).toBe('ready')
  })

  it('force=true bypasses the hash skip even when hashes match', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      ...baseFilm,
      sentimentGraph: { id: 'g1', reviewHash: HASH_3_REVIEWS },
    })
    mockReviewFindMany.mockResolvedValueOnce([
      qualityReview(1, 'hash-a'),
      qualityReview(2, 'hash-b'),
      qualityReview(3, 'hash-c'),
    ])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1', { force: true })

    // Without force this would be skipped_unchanged. With force it should be
    // ready so the admin "Analyze" button can regenerate.
    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.input.reviewHash).toBe(HASH_3_REVIEWS)
    }
  })

  it('force=true still returns skipped_insufficient_reviews — force does not bypass quality gate', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      ...baseFilm,
      sentimentGraph: null,
    })
    mockReviewFindMany.mockResolvedValueOnce([])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1', { force: true })

    expect(result.status).toBe('skipped_insufficient_reviews')
  })
})
