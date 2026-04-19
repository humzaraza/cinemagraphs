import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// prepareSentimentGraphInput reaches into prisma, OMDB, the review fetcher,
// and the Wikipedia plot source. We mock every external dependency so each
// test can control exactly how many quality reviews come back and assert on
// the threshold branch alone.

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

vi.mock('@/lib/logger', () => {
  const childLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    pipelineLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logger: { child: vi.fn(() => childLogger), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
})

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
  // 60 words of ASCII, well over the 50-word quality threshold.
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('prepareSentimentGraphInput — MIN_QUALITY_REVIEWS_FOR_GENERATION boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchAnchorScores.mockResolvedValue({
      imdbRating: null,
      rtCriticsScore: null,
      rtAudienceScore: null,
      metacriticScore: null,
    })
    mockFetchAllReviews.mockResolvedValue(undefined)
    mockFetchWikipediaPlot.mockResolvedValue(null)
  })

  it('returns skipped_insufficient_reviews with 0 quality reviews', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({ ...baseFilm, sentimentGraph: null })
    mockReviewFindMany.mockResolvedValueOnce([])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1')

    expect(result.status).toBe('skipped_insufficient_reviews')
    if (result.status === 'skipped_insufficient_reviews') {
      expect(result.qualityCount).toBe(0)
      expect(result.minRequired).toBe(3)
    }
  })

  it('returns skipped_insufficient_reviews with 1 quality review', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({ ...baseFilm, sentimentGraph: null })
    mockReviewFindMany.mockResolvedValueOnce([qualityReview(1, 'hash-a')])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1')

    expect(result.status).toBe('skipped_insufficient_reviews')
    if (result.status === 'skipped_insufficient_reviews') {
      expect(result.qualityCount).toBe(1)
      expect(result.minRequired).toBe(3)
    }
  })

  it('returns skipped_insufficient_reviews with 2 quality reviews', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({ ...baseFilm, sentimentGraph: null })
    mockReviewFindMany.mockResolvedValueOnce([
      qualityReview(1, 'hash-a'),
      qualityReview(2, 'hash-b'),
    ])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1')

    expect(result.status).toBe('skipped_insufficient_reviews')
    if (result.status === 'skipped_insufficient_reviews') {
      expect(result.qualityCount).toBe(2)
      expect(result.minRequired).toBe(3)
    }
  })

  it('does NOT return skipped_insufficient_reviews with 3 quality reviews (proceeds to ready)', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({ ...baseFilm, sentimentGraph: null })
    mockReviewFindMany.mockResolvedValueOnce([
      qualityReview(1, 'hash-a'),
      qualityReview(2, 'hash-b'),
      qualityReview(3, 'hash-c'),
    ])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1')

    expect(result.status).not.toBe('skipped_insufficient_reviews')
    expect(result.status).toBe('ready')
  })

  it('applies the same threshold to recent releases (no recency exemption)', async () => {
    const recentReleaseDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    mockFilmFindUnique.mockResolvedValueOnce({
      ...baseFilm,
      releaseDate: recentReleaseDate,
      sentimentGraph: null,
    })
    mockReviewFindMany.mockResolvedValueOnce([qualityReview(1, 'hash-a')])

    const { prepareSentimentGraphInput } = await import('@/lib/sentiment-pipeline')
    const result = await prepareSentimentGraphInput('film-1')

    expect(result.status).toBe('skipped_insufficient_reviews')
    if (result.status === 'skipped_insufficient_reviews') {
      expect(result.minRequired).toBe(3)
    }
  })
})
