import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Film } from '@/generated/prisma/client'

// fetchTMDBReviews logs through reviewLogger; stub it so the test is silent
// and does not depend on the pino setup.
vi.mock('@/lib/logger', () => ({
  reviewLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { fetchTMDBReviews } from '@/lib/sources/tmdb'

const film = { id: 'film-1', tmdbId: 123, title: 'Test Film' } as unknown as Film

// Review text must clear the 50 character floor the fetcher applies.
const longText = 'A review long enough to pass the minimum length filter in the fetcher. '.repeat(2)

describe('fetchTMDBReviews sourceRating mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn() as unknown as typeof fetch
  })

  it('stores a TMDB author rating of 8 as 8, on the 0 to 10 scale', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            author: 'Reviewer A',
            content: longText,
            url: 'https://www.themoviedb.org/review/abc',
            author_details: { rating: 8 },
          },
        ],
        total_pages: 1,
      }),
    })

    const result = await fetchTMDBReviews(film)

    expect(result.ok).toBe(true)
    expect(result.reviews).toHaveLength(1)
    expect(result.reviews[0].sourceRating).toBe(8)
  })

  it('stores null when the TMDB review carries no rating', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            author: 'Reviewer B',
            content: longText,
            url: null,
            author_details: { rating: null },
          },
        ],
        total_pages: 1,
      }),
    })

    const result = await fetchTMDBReviews(film)

    expect(result.ok).toBe(true)
    expect(result.reviews).toHaveLength(1)
    expect(result.reviews[0].sourceRating).toBeNull()
  })
})
