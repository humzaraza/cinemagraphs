/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import UserReviewSection, {
  type UserReviewSectionInitialData,
} from '@/components/UserReviewSection'

// UserReviewSection calls useSession(); render it as a signed-out viewer so
// the test focuses on the initialData / fetch behavior, not auth state.
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  signIn: vi.fn(),
}))

const initialData: UserReviewSectionInitialData = {
  reviews: [],
  summary: { avgRating: 7.4, totalReviews: 5, distribution: [] },
  totalPages: 1,
  myReview: null,
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          reviews: [],
          total: 0,
          page: 1,
          totalPages: 1,
          myReview: null,
          summary: {
            avgRating: null,
            totalReviews: 0,
            distribution: [],
            sectionCounts: { beginning: 0, middle: 0, ending: 0 },
          },
        }),
      ),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UserReviewSection: server-rendered initialData', () => {
  it('does not fire the reviews GET on mount when initialData is provided', () => {
    render(
      <UserReviewSection
        filmId="film-1"
        hasGraph={false}
        beats={[]}
        beatSource="none"
        initialData={initialData}
      />,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('renders the server-rendered community summary from initialData', () => {
    render(
      <UserReviewSection
        filmId="film-1"
        hasGraph={false}
        beats={[]}
        beatSource="none"
        initialData={initialData}
      />,
    )
    expect(
      screen.getByRole('heading', { name: /community reviews/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('7.4')).toBeInTheDocument()
  })

  it('falls back to the on-mount reviews GET when initialData is absent', async () => {
    render(
      <UserReviewSection filmId="film-1" hasGraph={false} beats={[]} beatSource="none" />,
    )
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/films/film-1/reviews?page=1')
    })
  })
})
