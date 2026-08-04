import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getMobileOrServerSession: vi.fn(),
  prisma: {
    userReview: { findUnique: vi.fn() },
    reviewLike: { count: vi.fn(), findUnique: vi.fn() },
    reviewReply: { count: vi.fn() },
  },
  apiLogger: { error: vi.fn() },
}))

vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))

const REVIEW_ID = 'r-1'
const AUTHOR_ID = 'u-author'
const VIEWER_ID = 'u-viewer'
const FILM_ID = 'f-1'

function getRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/reviews/${REVIEW_ID}`)
}

function params() {
  return { params: Promise.resolve({ id: REVIEW_ID }) }
}

// Shape of the prisma result for the handler's explicit select. Prisma only
// returns selected fields, so flagReason and user.email never appear here.
function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    userId: AUTHOR_ID,
    filmId: FILM_ID,
    overallRating: 8.5,
    beginning: 'Strong open.',
    middle: null,
    ending: 'Sticks the landing.',
    otherThoughts: null,
    combinedText: 'Strong open. Sticks the landing.',
    beatRatings: { 'Opening image': 7, Midpoint: 9 },
    status: 'approved',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-02T00:00:00Z'),
    user: { id: AUTHOR_ID, name: 'Author', image: null },
    film: {
      id: FILM_ID,
      title: 'Test Film',
      posterUrl: '/poster.jpg',
      releaseDate: new Date('2020-01-01T00:00:00Z'),
      director: 'Jane Doe',
      runtime: 120,
      sentimentGraph: {
        dataPoints: [
          { label: 'Opening image', score: 6, timeStart: 0, timeEnd: 10 },
          { label: 'Midpoint', score: 8, timeStart: 50, timeEnd: 60 },
        ],
      },
    },
    ...overrides,
  }
}

async function callGet() {
  const { GET } = await import('@/app/api/reviews/[id]/route')
  return GET(getRequest(), params())
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue(null)
  mocks.prisma.userReview.findUnique.mockResolvedValue(reviewRow())
  mocks.prisma.reviewLike.count.mockResolvedValue(3)
  mocks.prisma.reviewLike.findUnique.mockResolvedValue(null)
  mocks.prisma.reviewReply.count.mockResolvedValue(4)
})

describe('GET /api/reviews/[id]', () => {
  it('returns the full shape for an anonymous viewer with liked: false', async () => {
    const res = await callGet()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')

    const body = await res.json()
    expect(body).toEqual({
      id: REVIEW_ID,
      filmId: FILM_ID,
      overallRating: 8.5,
      beginning: 'Strong open.',
      middle: null,
      ending: 'Sticks the landing.',
      otherThoughts: null,
      combinedText: 'Strong open. Sticks the landing.',
      beatRatings: { 'Opening image': 7, Midpoint: 9 },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      user: { id: AUTHOR_ID, name: 'Author', image: null },
      film: {
        id: FILM_ID,
        title: 'Test Film',
        posterUrl: '/poster.jpg',
        releaseDate: '2020-01-01T00:00:00.000Z',
        director: 'Jane Doe',
        runtime: 120,
        sentimentGraph: {
          dataPoints: [
            { label: 'Opening image', score: 6, timeStart: 0, timeEnd: 10 },
            { label: 'Midpoint', score: 8, timeStart: 50, timeEnd: 60 },
          ],
        },
      },
      likes: { count: 3, liked: false },
      replyCount: 4,
    })

    // Anonymous viewers never trigger the per-viewer like lookup.
    expect(mocks.prisma.reviewLike.findUnique).not.toHaveBeenCalled()
  })

  it('never selects flagReason or user.email, and non-owners never see status or userId', async () => {
    const res = await callGet()
    const body = await res.json()

    expect(body).not.toHaveProperty('status')
    expect(body).not.toHaveProperty('userId')
    expect(body).not.toHaveProperty('flagReason')
    expect(body.user).not.toHaveProperty('email')

    // Pin the entire select. Deep equality fails on any added OR removed
    // field, so the mock resolving a static row cannot mask a select edit
    // (real Prisma returns only what was selected).
    expect(mocks.prisma.userReview.findUnique).toHaveBeenCalledWith({
      where: { id: REVIEW_ID },
      select: {
        id: true,
        userId: true,
        filmId: true,
        overallRating: true,
        beginning: true,
        middle: true,
        ending: true,
        otherThoughts: true,
        combinedText: true,
        beatRatings: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, image: true } },
        film: {
          select: {
            id: true,
            title: true,
            posterUrl: true,
            releaseDate: true,
            director: true,
            runtime: true,
            sentimentGraph: { select: { dataPoints: true } },
          },
        },
      },
    })
  })

  it('404s a flagged review for an anonymous viewer', async () => {
    mocks.prisma.userReview.findUnique.mockResolvedValue(reviewRow({ status: 'flagged' }))
    const res = await callGet()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Review not found' })
  })

  it('404s a flagged review for a signed-in non-owner, with the same body as a missing id', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: VIEWER_ID } })
    mocks.prisma.userReview.findUnique.mockResolvedValue(reviewRow({ status: 'flagged' }))
    const res = await callGet()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Review not found' })
  })

  it('404s a rejected review for a non-owner, pinning the guard to any non-approved status', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: VIEWER_ID } })
    mocks.prisma.userReview.findUnique.mockResolvedValue(reviewRow({ status: 'rejected' }))
    const res = await callGet()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Review not found' })
  })

  it('returns the owner their own flagged review, including status', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: AUTHOR_ID } })
    mocks.prisma.userReview.findUnique.mockResolvedValue(reviewRow({ status: 'flagged' }))
    const res = await callGet()
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.id).toBe(REVIEW_ID)
    expect(body.status).toBe('flagged')
    expect(body).not.toHaveProperty('flagReason')
    expect(body).not.toHaveProperty('userId')
  })

  it('returns liked: true when the viewer has liked the review', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: VIEWER_ID } })
    mocks.prisma.reviewLike.findUnique.mockResolvedValue({ id: 'like-1' })
    const res = await callGet()
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.likes).toEqual({ count: 3, liked: true })
    expect(mocks.prisma.reviewLike.count).toHaveBeenCalledWith({
      where: { reviewId: REVIEW_ID },
    })
    expect(mocks.prisma.reviewLike.findUnique).toHaveBeenCalledWith({
      where: { userId_reviewId: { userId: VIEWER_ID, reviewId: REVIEW_ID } },
      select: { id: true },
    })
    // A signed-in non-owner still gets no owner-only or internal fields.
    expect(body).not.toHaveProperty('status')
    expect(body).not.toHaveProperty('userId')
  })

  it('returns liked: false for a signed-in viewer who has not liked the review', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: VIEWER_ID } })
    const res = await callGet()
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.likes).toEqual({ count: 3, liked: false })
    // The lookup must actually run for signed-in viewers; liked must come
    // from its result, not from the mere presence of a session.
    expect(mocks.prisma.reviewLike.findUnique).toHaveBeenCalledWith({
      where: { userId_reviewId: { userId: VIEWER_ID, reviewId: REVIEW_ID } },
      select: { id: true },
    })
  })

  it('counts every reply row for the review so nested replies are included', async () => {
    mocks.prisma.reviewReply.count.mockResolvedValue(7)
    const res = await callGet()
    const body = await res.json()

    expect(body.replyCount).toBe(7)
    // The where clause must not filter on parentReplyId: the count covers
    // top-level comments and their children, matching the replies GET total.
    expect(mocks.prisma.reviewReply.count).toHaveBeenCalledWith({
      where: { reviewId: REVIEW_ID },
    })
  })

  it('404s a nonexistent id', async () => {
    mocks.prisma.userReview.findUnique.mockResolvedValue(null)
    const res = await callGet()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Review not found' })
  })
})
