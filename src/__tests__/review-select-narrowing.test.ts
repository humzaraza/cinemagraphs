import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Public read paths must never ship UserReview.status or .flagReason to the
 * wire (flagReason is moderator-authored text; a review flagged then
 * re-approved keeps it). The owner's own review keeps status (for the
 * Live / Under review / Rejected badge) but still never flagReason.
 *
 * The prisma mocks here simulate Prisma's `select` semantics: they start
 * from a full row (flagReason set, as on a flagged-then-approved review)
 * and return only the selected fields, so the assertions prove what
 * actually reaches the JSON response.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userReview: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    film: { findUnique: vi.fn() },
    follow: { count: vi.fn() },
    watchlist: { findMany: vi.fn() },
    list: { findMany: vi.fn() },
  },
  apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  getMobileOrServerSession: vi.fn(),
  extractSentiment: vi.fn(),
  maybeBlendAndUpdate: vi.fn(),
  checkSuspension: vi.fn(),
  invalidateFilmCache: vi.fn(),
  logActivity: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))
vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/sentiment-extract', () => ({ extractSentiment: mocks.extractSentiment }))
vi.mock('@/lib/review-blender', () => ({ maybeBlendAndUpdate: mocks.maybeBlendAndUpdate }))
vi.mock('@/lib/middleware', () => ({ checkSuspension: mocks.checkSuspension }))
vi.mock('@/lib/cache', () => ({ invalidateFilmCache: mocks.invalidateFilmCache }))
vi.mock('@/lib/activity', () => ({ logActivity: mocks.logActivity }))

// A review that was flagged and later approved by a moderator: status is
// 'approved' but the moderator's flagReason text is still stored.
const FULL_REVIEW_ROW = {
  id: 'r1',
  userId: 'author-1',
  filmId: 'film-1',
  overallRating: 8,
  beginning: 'strong open',
  middle: 'sags a bit',
  ending: 'sticks the landing',
  otherThoughts: null,
  combinedText: 'strong open sags a bit sticks the landing',
  beatRatings: { 'Act 1': 8 },
  sentiment: 0.4,
  status: 'approved',
  flagReason: 'Account created less than 24 hours ago',
  createdAt: new Date('2026-06-01'),
  updatedAt: new Date('2026-06-02'),
  user: { id: 'author-1', name: 'Alice', image: null, email: 'a@example.com' },
  film: { id: 'film-1', title: 'Film One' },
}

type Select = Record<string, unknown>

// Minimal simulation of Prisma select semantics, enough for these queries:
// pick exactly the selected keys; recurse into nested { select } relations.
function applySelect(row: Record<string, unknown>, select: Select): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(select)) {
    if (spec === true) {
      out[key] = row[key]
    } else if (spec && typeof spec === 'object') {
      const nestedSelect = (spec as { select?: Select }).select ?? (spec as Select)
      const value = row[key]
      if (Array.isArray(value)) {
        out[key] = value.map((v) => applySelect(v as Record<string, unknown>, nestedSelect))
      } else if (value && typeof value === 'object') {
        out[key] = applySelect(value as Record<string, unknown>, nestedSelect)
      } else {
        out[key] = value ?? null
      }
    }
  }
  return out
}

/**
 * What holds on every single-review read path, whatever the viewer: raw
 * moderator text and the internal sentiment score never ship, updatedAt is
 * not part of any review payload, and the public fields are intact.
 */
function expectNarrowedReview(review: Record<string, unknown>) {
  expect(review).not.toHaveProperty('flagReason')
  expect(review).not.toHaveProperty('sentiment')
  expect(review).not.toHaveProperty('updatedAt')
  expect(review).toMatchObject({
    id: 'r1',
    overallRating: 8,
    beginning: 'strong open',
    combinedText: 'strong open sags a bit sticks the landing',
    beatRatings: { 'Act 1': 8 },
    user: { id: 'author-1', name: 'Alice', image: null },
  })
}

/** The above, plus the two fields only a visibility check may look at. */
function expectPublicShape(review: Record<string, unknown>) {
  expectNarrowedReview(review)
  expect(review).not.toHaveProperty('status')
  expect(review).not.toHaveProperty('userId')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue(null)
  mocks.checkSuspension.mockResolvedValue(null)
  mocks.extractSentiment.mockResolvedValue(0.4)
  mocks.maybeBlendAndUpdate.mockResolvedValue(undefined)
  mocks.invalidateFilmCache.mockResolvedValue(undefined)
  mocks.prisma.userReview.count.mockResolvedValue(1)
})

describe('shared review selects (film-detail.ts)', () => {
  it('publicReviewSelect excludes status, flagReason, sentiment, userId, updatedAt', async () => {
    const { publicReviewSelect } = await import('@/lib/film-detail')
    expect(publicReviewSelect).not.toHaveProperty('status')
    expect(publicReviewSelect).not.toHaveProperty('flagReason')
    expect(publicReviewSelect).not.toHaveProperty('sentiment')
    expect(publicReviewSelect).not.toHaveProperty('userId')
    expect(publicReviewSelect).not.toHaveProperty('updatedAt')
  })

  it('ownerReviewSelect adds status but still never flagReason', async () => {
    const { ownerReviewSelect } = await import('@/lib/film-detail')
    expect(ownerReviewSelect).toHaveProperty('status', true)
    expect(ownerReviewSelect).not.toHaveProperty('flagReason')
  })
})

describe('GET /api/users/[id] (unauthenticated, public)', () => {
  it('review rows contain no status and no flagReason, even when flagReason is stored', async () => {
    mocks.prisma.user.findUnique.mockImplementation(async ({ select }: { select: Select }) => {
      const userRow = {
        id: 'author-1',
        name: 'Alice',
        username: 'alice',
        image: null,
        bio: null,
        createdAt: new Date('2026-01-01'),
        bannerType: 'GRADIENT',
        bannerValue: 'midnight',
        userReviews: [FULL_REVIEW_ROW],
        liveReactions: [],
      }
      return applySelect(userRow, select)
    })
    mocks.prisma.follow.count.mockResolvedValue(0)
    mocks.prisma.watchlist.findMany.mockResolvedValue([])
    mocks.prisma.list.findMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/users/[id]/route')
    const res = await GET(new NextRequest('http://localhost/api/users/author-1'), {
      params: Promise.resolve({ id: 'author-1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reviews).toHaveLength(1)
    expectPublicShape(body.reviews[0])
    // The film context the profile cards need is still there.
    expect(body.reviews[0].film).toBeDefined()
  })
})

describe('GET /api/films/[id]/reviews', () => {
  function reviewsGET(query = '') {
    return import('@/app/api/films/[id]/reviews/route').then(({ GET }) =>
      GET(new NextRequest(`http://localhost/api/films/film-1/reviews${query}`), {
        params: Promise.resolve({ id: 'film-1' }),
      }),
    )
  }

  beforeEach(() => {
    mocks.prisma.userReview.findMany.mockImplementation(
      async ({ select }: { select?: Select }) => {
        // The summary aggregate query has its own scalar select; honor both.
        return [applySelect(FULL_REVIEW_ROW, select ?? {})]
      },
    )
  })

  it('public list rows contain neither status nor flagReason', async () => {
    const res = await reviewsGET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reviews).toHaveLength(1)
    expectPublicShape(body.reviews[0])
    expect(body.myReview).toBeNull()
  })

  it('myReview contains status but not flagReason', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: 'author-1' } })
    mocks.prisma.userReview.findUnique.mockImplementation(async ({ select }: { select: Select }) =>
      applySelect(FULL_REVIEW_ROW, select),
    )

    const res = await reviewsGET()
    const body = await res.json()
    expect(body.myReview.status).toBe('approved')
    expect(body.myReview).not.toHaveProperty('flagReason')
    expect(body.myReview).not.toHaveProperty('sentiment')
  })
})

describe('POST /api/films/[id]/reviews (create and edit responses)', () => {
  function reviewsPOST() {
    const req = new NextRequest('http://localhost/api/films/film-1/reviews', {
      method: 'POST',
      body: JSON.stringify({ overallRating: 8, beginning: 'strong open' }),
      headers: { 'Content-Type': 'application/json' },
    })
    return import('@/app/api/films/[id]/reviews/route').then(({ POST }) =>
      POST(req, { params: Promise.resolve({ id: 'film-1' }) }),
    )
  }

  beforeEach(() => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: 'author-1' } })
    mocks.prisma.film.findUnique.mockResolvedValue({
      id: 'film-1',
      sentimentGraph: null,
      filmBeats: null,
    })
    mocks.prisma.user.findUnique.mockResolvedValue({ createdAt: new Date('2026-01-01') })
  })

  it('create response contains status (owner needs the badge) but no flagReason', async () => {
    mocks.prisma.userReview.findUnique.mockResolvedValue(null) // no existing review
    mocks.prisma.userReview.create.mockImplementation(async ({ select }: { select: Select }) =>
      applySelect(FULL_REVIEW_ROW, select),
    )

    const res = await reviewsPOST()
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.status).toBe('approved')
    expect(body).not.toHaveProperty('flagReason')
    expect(body).not.toHaveProperty('sentiment')
  })

  it('edit response contains status but no flagReason', async () => {
    mocks.prisma.userReview.findUnique.mockResolvedValue({ id: 'r1' }) // existing review
    mocks.prisma.userReview.update.mockImplementation(async ({ select }: { select: Select }) =>
      applySelect(FULL_REVIEW_ROW, select),
    )

    const res = await reviewsPOST()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('approved')
    expect(body).not.toHaveProperty('flagReason')
  })
})

describe('getReviewById (review detail page loader)', () => {
  it('selects the public shape plus the two fields canViewReview needs, never flagReason or sentiment', async () => {
    mocks.prisma.userReview.findUnique.mockImplementation(async ({ select }: { select: Select }) =>
      applySelect(FULL_REVIEW_ROW, select),
    )

    const { getReviewById } = await import('@/lib/review-detail')
    const review = (await getReviewById('r1')) as unknown as Record<string, unknown>
    expect(review).not.toBeNull()

    // Everything the other public read paths guarantee still holds here.
    expectNarrowedReview(review)

    // status and userId are present on purpose, widened in the
    // review-page-status-guard PR rather than drifted: /reviews/[id] has to
    // run canViewReview, and publicReviewSelect carries neither field. This
    // one loader selects them on top of it; the page destructures both off
    // before rendering. publicReviewSelect itself stays narrow, which the
    // expectPublicShape cases above pin for every other caller.
    expect(review).toHaveProperty('status', 'approved')
    expect(review).toHaveProperty('userId', 'author-1')

    expect(review.film).toBeDefined()
  })
})
