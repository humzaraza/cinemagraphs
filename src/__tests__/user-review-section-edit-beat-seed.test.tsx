/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import UserReviewSection, {
  type UserReviewSectionInitialData,
} from '@/components/UserReviewSection'

/**
 * Edge cases of startEditing's seeding pass that
 * user-review-section-touched-only.test.tsx does not reach: a stored empty
 * map, and stored labels the film's current beat selection no longer offers.
 * The main partial-map and stored-null cases live in that file; they are not
 * repeated here.
 *
 * The POST body shape asserted below, { overallRating, beginning,
 * beatRatings }, was read from handleSubmit in
 * src/components/UserReviewSection.tsx in this same PR.
 */

// One test submits, so the viewer has to be signed in: handleSubmit bails to
// signIn() when the session is null.
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 'me', name: 'Me' }, expires: '2099-01-01T00:00:00.000Z' },
    status: 'authenticated',
  }),
  signIn: vi.fn(),
}))

const BEATS = [
  { label: 'Opening', score: 6 },
  { label: 'Climax', score: 8 },
]

const REFETCH_PAYLOAD = {
  reviews: [],
  total: 0,
  page: 1,
  totalPages: 1,
  myReview: null,
  summary: { avgRating: null, totalReviews: 0, distribution: [] },
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(REFETCH_PAYLOAD), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

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
}

function beatSliders(): HTMLInputElement[] {
  const sliders = screen.getAllByRole('slider') as HTMLInputElement[]
  // First slider is the overall rating; the rest map 1:1 onto BEATS in order.
  expect(sliders).toHaveLength(1 + BEATS.length)
  return sliders.slice(1)
}

describe('UserReviewSection: edit path beat-rating seeding', () => {
  it('stored empty map: reopens with nothing rated, 5.5 showing as presentation only', () => {
    renderAndStartEditing({})
    expect(screen.getByText(`0 of ${BEATS.length} rated`)).toBeInTheDocument()
    expect(screen.getAllByText('Not rated')).toHaveLength(BEATS.length)
    expect(screen.queryByRole('button', { name: /^clear your rating for/i })).toBeNull()
    for (const slider of beatSliders()) {
      // The thumb needs a position, so it sits at the midpoint. That 5.5 is
      // display only: the beat is announced as unrated and holds no key.
      expect(slider.value).toBe('5.5')
      expect(slider).toHaveAttribute('aria-valuetext', 'Not rated')
    }
    // The old unseeded fallback ("5.0") must not reappear either. No check on
    // "5.5" here: the overall-rating slider prints it as a scale label, so it
    // is in the document for reasons unrelated to the beats.
    expect(screen.queryByText('5.0')).not.toBeInTheDocument()
  })

  it('drops stored labels the current beat selection no longer offers', async () => {
    // The film's beats changed since the review was written, so "Retired Beat"
    // has no slider. It cannot be displayed, kept or cleared, so it is not
    // seeded and a resubmit does not silently carry it back to the database.
    renderAndStartEditing({ Opening: 8, 'Retired Beat': 3 })

    expect(screen.getByText(`1 of ${BEATS.length} rated`)).toBeInTheDocument()
    expect(screen.queryByText('Retired Beat')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Clear your rating for Retired Beat' }),
    ).toBeNull()
    expect(beatSliders().map((s) => s.value)).toEqual(['8', '5.5'])

    fireEvent.click(screen.getByRole('button', { name: /^update review$/i }))
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.find(([, init]) => init?.method === 'POST'),
      ).toBeDefined()
    })
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    const body = JSON.parse(post[1].body as string)
    expect(body.beatRatings).toEqual({ Opening: 8 })
    expect(body.beatRatings).not.toHaveProperty('Retired Beat')
  })
})
