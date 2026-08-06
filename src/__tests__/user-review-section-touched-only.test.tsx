/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import UserReviewSection, {
  type UserReviewSectionInitialData,
} from '@/components/UserReviewSection'

// These tests submit the form, so the viewer has to be signed in: handleSubmit
// bails to signIn() when the session is null.
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 'me', name: 'Me' }, expires: '2099-01-01T00:00:00.000Z' },
    status: 'authenticated',
  }),
  signIn: vi.fn(),
}))

const BEATS = [
  { label: 'Opening', score: 6 },
  { label: 'Turn', score: 4 },
  { label: 'Climax', score: 9 },
  { label: 'Closing', score: 5 },
]

/**
 * The POST body shape asserted throughout this file, { overallRating,
 * beginning, beatRatings }, was read directly from handleSubmit in
 * src/components/UserReviewSection.tsx in this same PR, not invented or
 * inferred from the route. handleSubmit JSON.stringify's exactly those three
 * keys, and JSON.stringify omits any of them whose value is undefined, which
 * is how "no beatRatings key" reaches the wire.
 */
function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// handleSubmit calls fetchReviews(1) after a successful POST, so the mock has
// to answer the follow-up GET too.
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
  fetchMock = vi.fn(async () => jsonResponse(REFETCH_PAYLOAD))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeInitialData(
  myBeatRatings: Record<string, number> | null | undefined,
): UserReviewSectionInitialData {
  return {
    reviews: [],
    summary: { avgRating: null, totalReviews: 0, distribution: [] },
    totalPages: 1,
    myReview:
      myBeatRatings === undefined
        ? null
        : {
            id: 'review-1',
            overallRating: 7,
            beginning: 'Fine film.',
            middle: null,
            ending: null,
            otherThoughts: null,
            combinedText: 'Fine film.',
            beatRatings: myBeatRatings,
            status: 'approved',
            createdAt: '2026-08-01T00:00:00.000Z',
            user: { id: 'me', name: 'Me', image: null },
          },
  }
}

/** Fresh create form: no existing review. */
function renderCreateForm() {
  render(
    <UserReviewSection
      filmId="film-1"
      hasGraph={true}
      beats={BEATS}
      beatSource="graph"
      initialData={makeInitialData(undefined)}
    />,
  )
}

/** Existing review, reopened through "Edit your review". */
function renderAndStartEditing(stored: Record<string, number> | null) {
  render(
    <UserReviewSection
      filmId="film-1"
      hasGraph={true}
      beats={BEATS}
      beatSource="graph"
      initialData={makeInitialData(stored)}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /edit your review/i }))
}

function beatSliders(): HTMLInputElement[] {
  const sliders = screen.getAllByRole('slider') as HTMLInputElement[]
  // The first slider is the overall rating; the rest map 1:1 onto BEATS in
  // order (4 beats stay under selectBeats' 8-beat cap, so none are dropped).
  expect(sliders).toHaveLength(1 + BEATS.length)
  return sliders.slice(1)
}

function rateBeat(index: number, value: number) {
  fireEvent.change(beatSliders()[index], { target: { value: String(value) } })
}

function clearBeat(label: string) {
  fireEvent.click(screen.getByRole('button', { name: `Clear your rating for ${label}` }))
}

/** Submits and returns the parsed POST body the component actually sent. */
async function submitAndReadBody(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: /^(submit|update) review$/i }))
  await waitFor(() => {
    expect(
      fetchMock.mock.calls.find(([, init]) => init?.method === 'POST'),
    ).toBeDefined()
  })
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(post[0]).toBe('/api/films/film-1/reviews')
  return JSON.parse(post[1].body as string)
}

describe('UserReviewSection: only deliberately rated beats are submitted', () => {
  it('sends no beatRatings key when the viewer touched no beat slider', async () => {
    renderCreateForm()
    const body = await submitAndReadBody()
    expect('beatRatings' in body).toBe(false)
  })

  it('sends exactly the two beats the viewer touched, not all four', async () => {
    renderCreateForm()
    rateBeat(0, 8) // Opening
    rateBeat(2, 3) // Climax
    const body = await submitAndReadBody()
    expect(body.beatRatings).toEqual({ Opening: 8, Climax: 3 })
    expect(Object.keys(body.beatRatings as object)).toHaveLength(2)
  })

  it('resubmitting an untouched edit keeps the stored 2 beats and does not grow to 4', async () => {
    renderAndStartEditing({ Opening: 8, Closing: 2.5 })
    const body = await submitAndReadBody()
    expect(body.beatRatings).toEqual({ Opening: 8, Closing: 2.5 })
    expect(Object.keys(body.beatRatings as object)).toHaveLength(2)
    expect(body.beatRatings).not.toHaveProperty('Turn')
    expect(body.beatRatings).not.toHaveProperty('Climax')
  })

  it('drops a beat that was rated and then cleared, keeping the others', async () => {
    renderCreateForm()
    rateBeat(0, 8) // Opening
    rateBeat(2, 3) // Climax
    clearBeat('Opening')
    const body = await submitAndReadBody()
    expect(body.beatRatings).toEqual({ Climax: 3 })
    expect(body.beatRatings).not.toHaveProperty('Opening')
  })

  it('sends no beatRatings key when the only rated beat is cleared again', async () => {
    renderCreateForm()
    rateBeat(1, 9) // Turn
    clearBeat('Turn')
    const body = await submitAndReadBody()
    expect('beatRatings' in body).toBe(false)
  })
})

describe('UserReviewSection: unrated beats read as unrated', () => {
  it('starts every beat unrated, with no clear controls and a 0 of N counter', () => {
    renderCreateForm()
    expect(screen.getByText(`0 of ${BEATS.length} rated`)).toBeInTheDocument()
    expect(screen.getAllByText('Not rated')).toHaveLength(BEATS.length)
    expect(screen.queryByRole('button', { name: /^clear your rating for/i })).toBeNull()
    for (const slider of beatSliders()) {
      expect(slider).toHaveAttribute('aria-valuetext', 'Not rated')
      // Presentation-only midpoint: the thumb has a position, state has no key.
      expect(slider.value).toBe('5.5')
    }
  })

  it('promotes only the touched beat to rated and exposes a named clear button', () => {
    renderCreateForm()
    rateBeat(0, 8)
    expect(screen.getByText(`1 of ${BEATS.length} rated`)).toBeInTheDocument()
    expect(screen.getAllByText('Not rated')).toHaveLength(BEATS.length - 1)
    expect(screen.getByText('8.0')).toBeInTheDocument()
    const clear = screen.getByRole('button', { name: 'Clear your rating for Opening' })
    expect(clear).toBeInTheDocument()
    expect(beatSliders()[0]).not.toHaveAttribute('aria-valuetext')
    // Clearing returns the beat to the unrated presentation.
    fireEvent.click(clear)
    expect(screen.getByText(`0 of ${BEATS.length} rated`)).toBeInTheDocument()
    expect(beatSliders()[0]).toHaveAttribute('aria-valuetext', 'Not rated')
  })

  it('reopens an edit with only the stored beats rated', () => {
    renderAndStartEditing({ Opening: 8, Closing: 2.5 })
    expect(screen.getByText(`2 of ${BEATS.length} rated`)).toBeInTheDocument()
    expect(screen.getAllByText('Not rated')).toHaveLength(2)
    expect(beatSliders().map((s) => s.value)).toEqual(['8', '5.5', '5.5', '2.5'])
  })

  it('reopens an edit with a stored null map as nothing rated', () => {
    renderAndStartEditing(null)
    expect(screen.getByText(`0 of ${BEATS.length} rated`)).toBeInTheDocument()
    expect(screen.getAllByText('Not rated')).toHaveLength(BEATS.length)
  })
})
