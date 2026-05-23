import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  prisma: {
    userReview: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    watchlist: { findUnique: vi.fn() },
    liveReactionSession: { count: vi.fn(), findMany: vi.fn() },
    liveReaction: { findMany: vi.fn() },
    sentimentGraph: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))

import {
  getFilmReviewsPage,
  getUserReviewForFilm,
  getFilmAudienceData,
  getWatchlistStatus,
} from '@/lib/film-detail'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getFilmReviewsPage', () => {
  it('returns the page-1 list, total, totalPages and the community summary', async () => {
    mocks.prisma.userReview.findMany
      .mockResolvedValueOnce([{ id: 'r1' }]) // paginated list
      .mockResolvedValueOnce([
        // every approved review, for the summary
        { overallRating: 8, sentiment: 0.5, beginning: 'x', middle: null, ending: null },
        { overallRating: 6, sentiment: null, beginning: null, middle: 'y', ending: null },
      ])
    mocks.prisma.userReview.count.mockResolvedValue(7)

    const result = await getFilmReviewsPage('film-1')

    expect(result.reviews).toEqual([{ id: 'r1' }])
    expect(result.total).toBe(7)
    expect(result.page).toBe(1)
    expect(result.totalPages).toBe(2) // ceil(7 / 5)
    expect(result.summary.avgRating).toBe(7) // (8 + 6) / 2
    expect(result.summary.totalReviews).toBe(7)
    expect(result.summary.distribution).toHaveLength(10)
    expect(result.summary.distribution[7]).toEqual({ score: 8, count: 1 })
    expect(result.summary.sectionCounts).toEqual({ beginning: 1, middle: 1, ending: 0 })
  })

  it('paginates the list with skip/take', async () => {
    mocks.prisma.userReview.findMany.mockResolvedValue([])
    mocks.prisma.userReview.count.mockResolvedValue(0)

    await getFilmReviewsPage('film-1', 3)

    const listCall = mocks.prisma.userReview.findMany.mock.calls.find(
      ([arg]) => (arg as { skip?: number })?.skip !== undefined,
    )!
    expect((listCall[0] as { skip: number; take: number }).skip).toBe(10) // (3 - 1) * 5
    expect((listCall[0] as { skip: number; take: number }).take).toBe(5)
  })

  it('excludeUserId filters the list + count but never the summary', async () => {
    mocks.prisma.userReview.findMany.mockResolvedValue([])
    mocks.prisma.userReview.count.mockResolvedValue(0)

    await getFilmReviewsPage('film-1', 1, 'user-9')

    const listCall = mocks.prisma.userReview.findMany.mock.calls.find(
      ([arg]) => (arg as { skip?: number })?.skip !== undefined,
    )!
    expect((listCall[0] as { where: unknown }).where).toEqual({
      filmId: 'film-1',
      status: 'approved',
      userId: { not: 'user-9' },
    })
    const summaryCall = mocks.prisma.userReview.findMany.mock.calls.find(
      ([arg]) => (arg as { skip?: number })?.skip === undefined,
    )!
    expect((summaryCall[0] as { where: unknown }).where).toEqual({
      filmId: 'film-1',
      status: 'approved',
    })
    expect(mocks.prisma.userReview.count).toHaveBeenCalledWith({
      where: { filmId: 'film-1', status: 'approved', userId: { not: 'user-9' } },
    })
  })

  it('a null excludeUserId leaves the list filter unfiltered by user', async () => {
    mocks.prisma.userReview.findMany.mockResolvedValue([])
    mocks.prisma.userReview.count.mockResolvedValue(0)

    await getFilmReviewsPage('film-1')

    const listCall = mocks.prisma.userReview.findMany.mock.calls.find(
      ([arg]) => (arg as { skip?: number })?.skip !== undefined,
    )!
    expect((listCall[0] as { where: unknown }).where).toEqual({
      filmId: 'film-1',
      status: 'approved',
    })
  })
})

describe('getUserReviewForFilm', () => {
  it('looks the review up by the (userId, filmId) composite key', async () => {
    mocks.prisma.userReview.findUnique.mockResolvedValue({ id: 'r1' })

    const result = await getUserReviewForFilm('film-1', 'user-1')

    expect(result).toEqual({ id: 'r1' })
    expect(mocks.prisma.userReview.findUnique).toHaveBeenCalledWith({
      where: { userId_filmId: { userId: 'user-1', filmId: 'film-1' } },
      include: { user: { select: { id: true, name: true, image: true } } },
    })
  })
})

describe('getWatchlistStatus', () => {
  it('returns true when a watchlist row exists', async () => {
    mocks.prisma.watchlist.findUnique.mockResolvedValue({ id: 'w1' })
    expect(await getWatchlistStatus('film-1', 'user-1')).toBe(true)
  })

  it('returns false when no watchlist row exists', async () => {
    mocks.prisma.watchlist.findUnique.mockResolvedValue(null)
    expect(await getWatchlistStatus('film-1', 'user-1')).toBe(false)
  })
})

describe('getFilmAudienceData', () => {
  it('averages beat ratings and skips reaction scores below 20 quality sessions', async () => {
    mocks.prisma.userReview.findMany.mockResolvedValue([
      { beatRatings: { Opening: 8 }, overallRating: 8 },
      { beatRatings: { Opening: 6 }, overallRating: 6 },
      { beatRatings: null, overallRating: 5 },
    ])
    mocks.prisma.liveReactionSession.count.mockResolvedValue(4)

    const result = await getFilmAudienceData('film-1')

    expect(result.userReviewCount).toBe(3)
    expect(result.beatAverages).toEqual({ Opening: 7 })
    expect(result.liveSessionCount).toBe(4)
    expect(result.reactionScores).toEqual([])
    // Under 20 quality sessions, the reaction queries are not run.
    expect(mocks.prisma.liveReaction.findMany).not.toHaveBeenCalled()
  })

  it('computes time-bucketed reaction scores once 20+ quality sessions exist', async () => {
    mocks.prisma.userReview.findMany.mockResolvedValue([])
    mocks.prisma.liveReactionSession.count.mockResolvedValue(20)
    mocks.prisma.liveReactionSession.findMany.mockResolvedValue([{ id: 's1' }])
    mocks.prisma.liveReaction.findMany.mockResolvedValue([
      { score: 8, sessionTimestamp: 60 }, // 1 minute in
    ])
    mocks.prisma.sentimentGraph.findUnique.mockResolvedValue({
      dataPoints: [{ timeStart: 0, timeEnd: 5 }],
    })

    const result = await getFilmAudienceData('film-1')

    expect(result.liveSessionCount).toBe(20)
    expect(result.reactionScores).toHaveLength(1)
    expect(result.reactionScores[0].index).toBe(0)
    expect(mocks.prisma.liveReaction.findMany).toHaveBeenCalledTimes(1)
  })
})
