/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import UserReviewSection, {
  type UserReviewSectionInitialData,
} from '@/components/UserReviewSection'

// UserReviewSection calls useSession(); auth state is irrelevant here, the
// test only exercises the edit path's state seeding.
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  signIn: vi.fn(),
}))

const BEATS = [
  { label: 'Opening', score: 6 },
  { label: 'Climax', score: 8 },
]

function makeInitialData(
  beatRatings: Record<string, number> | null,
): UserReviewSectionInitialData {
  return {
    reviews: [],
    summary: { avgRating: null, totalReviews: 0, distribution: [] },
    totalPages: 1,
    myReview: {
      id: 'review-1',
      overallRating: 7,
      beginning: 'Fine film.',
      middle: null,
      ending: null,
      otherThoughts: null,
      combinedText: 'Fine film.',
      beatRatings,
      status: 'approved',
      createdAt: '2026-08-01T00:00:00.000Z',
      user: { id: 'me', name: 'Me', image: null },
    },
  }
}

function renderAndStartEditing(beatRatings: Record<string, number> | null) {
  render(
    <UserReviewSection
      filmId="film-1"
      hasGraph={true}
      beats={BEATS}
      beatSource="graph"
      initialData={makeInitialData(beatRatings)}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /edit your review/i }))
  // First slider is the overall rating; the rest are the beat sliders.
  const sliders = screen.getAllByRole('slider') as HTMLInputElement[]
  expect(sliders).toHaveLength(1 + BEATS.length)
  return sliders.slice(1)
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UserReviewSection: edit path beat-rating seeding', () => {
  it('stored null: seeds create-mode defaults so sliders display what a resubmit would send', () => {
    const beatSliders = renderAndStartEditing(null)
    for (const slider of beatSliders) {
      expect(slider.value).toBe('5.5')
    }
    // The unseeded fallback the bug used to show ("5.0") must not appear.
    expect(screen.queryByText('5.0')).not.toBeInTheDocument()
  })

  it('stored empty object: seeds create-mode defaults the same way', () => {
    const beatSliders = renderAndStartEditing({})
    for (const slider of beatSliders) {
      expect(slider.value).toBe('5.5')
    }
    expect(screen.queryByText('5.0')).not.toBeInTheDocument()
  })

  it('stored partial map: keeps stored values and defaults the uncovered beats', () => {
    const beatSliders = renderAndStartEditing({ Opening: 8 })
    expect(beatSliders.map((s) => s.value)).toEqual(['8', '5.5'])
    expect(screen.queryByText('5.0')).not.toBeInTheDocument()
  })
})
