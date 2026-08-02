import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFollowFindMany = vi.fn()
const mockActivityFindMany = vi.fn()
const mockUserReviewFindMany = vi.fn()
const mockFilmFindMany = vi.fn()
const mockListFindMany = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    follow: {
      findMany: (...args: unknown[]) => mockFollowFindMany(...args),
    },
    activity: {
      findMany: (...args: unknown[]) => mockActivityFindMany(...args),
    },
    userReview: {
      findMany: (...args: unknown[]) => mockUserReviewFindMany(...args),
    },
    film: {
      findMany: (...args: unknown[]) => mockFilmFindMany(...args),
    },
    list: {
      findMany: (...args: unknown[]) => mockListFindMany(...args),
    },
  },
}))

import { getFriendsFeed, FEED_PAGE_SIZE } from '@/lib/activity-feed'

const ACTOR = { id: 'u-1', name: 'Ana', image: null }

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act-1',
    actorId: 'u-1',
    type: 'watchlist',
    createdAt: new Date('2026-08-01T12:00:00Z'),
    targetUserId: null,
    reviewId: null,
    filmId: null,
    replyId: null,
    listId: null,
    actor: ACTOR,
    targetUser: null,
    ...overrides,
  }
}

const FILM = { id: 'f-1', title: 'The Third Man', posterUrl: '/poster.jpg' }

beforeEach(() => {
  vi.clearAllMocks()
  // Defaults: one followed user, no activity, no referents. Individual
  // tests override what they need.
  mockFollowFindMany.mockResolvedValue([{ followingId: 'u-1' }])
  mockActivityFindMany.mockResolvedValue([])
  mockUserReviewFindMany.mockResolvedValue([])
  mockFilmFindMany.mockResolvedValue([])
  mockListFindMany.mockResolvedValue([])
})

describe('getFriendsFeed: follow scoping', () => {
  it('returns the empty shape without querying activities when the viewer follows no one', async () => {
    mockFollowFindMany.mockResolvedValue([])

    const feed = await getFriendsFeed('viewer-1', 1)

    expect(feed).toEqual({ items: [], page: 1, hasMore: false })
    expect(mockActivityFindMany).not.toHaveBeenCalled()
  })

  it('scopes the activity query to followed actor ids only', async () => {
    mockFollowFindMany.mockResolvedValue([{ followingId: 'u-1' }, { followingId: 'u-2' }])

    await getFriendsFeed('viewer-1', 1)

    expect(mockActivityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorId: { in: ['u-1', 'u-2'] } }),
      })
    )
  })

  it('excludes banned members: a followed member with role BANNED contributes no rows', async () => {
    // The role filter lives in the follow query itself, so a banned
    // member's follow row never comes back and their id never reaches
    // the activity query's actor scope.
    mockFollowFindMany.mockResolvedValue([{ followingId: 'u-good' }])

    await getFriendsFeed('viewer-1', 1)

    expect(mockFollowFindMany).toHaveBeenCalledWith({
      where: { followerId: 'viewer-1', following: { role: { not: 'BANNED' } } },
      select: { followingId: true },
    })
    expect(mockActivityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorId: { in: ['u-good'] } }),
      })
    )
  })

  it('excludes likes and replies from the feed via the type filter', async () => {
    await getFriendsFeed('viewer-1', 1)

    const where = mockActivityFindMany.mock.calls[0][0].where
    expect(where.type.in).toEqual(['review', 'follow', 'watchlist', 'list_add'])
    expect(where.type.in).not.toContain('like')
    expect(where.type.in).not.toContain('reply')
  })
})

describe('getFriendsFeed: referent resolution and dropping', () => {
  it('keeps an approved review row and shapes it from the review referent', async () => {
    mockActivityFindMany.mockResolvedValue([
      activityRow({ id: 'act-r', type: 'review', reviewId: 'r-1', filmId: 'f-1' }),
    ])
    mockUserReviewFindMany.mockResolvedValue([
      { id: 'r-1', user: ACTOR, film: FILM },
    ])
    mockFilmFindMany.mockResolvedValue([FILM])

    const feed = await getFriendsFeed('viewer-1', 1)

    expect(feed.items).toEqual([
      {
        id: 'act-r',
        type: 'review',
        createdAt: '2026-08-01T12:00:00.000Z',
        actor: ACTOR,
        targetUser: null,
        film: FILM,
        review: { id: 'r-1' },
        list: null,
      },
    ])
    // The status filter is applied in the query itself.
    expect(mockUserReviewFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['r-1'] }, status: 'approved' },
      })
    )
  })

  it('drops a review row whose review is no longer approved', async () => {
    mockActivityFindMany.mockResolvedValue([
      activityRow({ id: 'act-r', type: 'review', reviewId: 'r-flagged', filmId: 'f-1' }),
    ])
    // The status: 'approved' filter means a flagged review comes back empty.
    mockUserReviewFindMany.mockResolvedValue([])
    mockFilmFindMany.mockResolvedValue([FILM])

    const feed = await getFriendsFeed('viewer-1', 1)

    expect(feed.items).toEqual([])
  })

  it('drops a list_add row whose list is private and keeps a public one', async () => {
    mockActivityFindMany.mockResolvedValue([
      activityRow({ id: 'act-private', type: 'list_add', filmId: 'f-1', listId: 'l-private' }),
      activityRow({ id: 'act-public', type: 'list_add', filmId: 'f-1', listId: 'l-public' }),
    ])
    mockFilmFindMany.mockResolvedValue([FILM])
    // The isPublic: true filter means only the public list comes back.
    mockListFindMany.mockResolvedValue([{ id: 'l-public', name: 'Noir Essentials' }])

    const feed = await getFriendsFeed('viewer-1', 1)

    expect(feed.items).toHaveLength(1)
    expect(feed.items[0].id).toBe('act-public')
    expect(feed.items[0].list).toEqual({ id: 'l-public', name: 'Noir Essentials' })
    expect(mockListFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['l-private', 'l-public'] }, isPublic: true },
      })
    )
  })

  it('drops rows with a missing referent (deleted film, vanished target user)', async () => {
    mockActivityFindMany.mockResolvedValue([
      activityRow({ id: 'act-w', type: 'watchlist', filmId: 'f-gone' }),
      activityRow({ id: 'act-f', type: 'follow', targetUserId: 'u-gone', targetUser: null }),
      activityRow({ id: 'act-ok', type: 'watchlist', filmId: 'f-1' }),
    ])
    mockFilmFindMany.mockResolvedValue([FILM])

    const feed = await getFriendsFeed('viewer-1', 1)

    expect(feed.items.map((i) => i.id)).toEqual(['act-ok'])
  })

  it('keeps a follow row whose target user resolved, stripping the internal role field', async () => {
    mockActivityFindMany.mockResolvedValue([
      activityRow({
        id: 'act-f',
        type: 'follow',
        targetUserId: 'u-2',
        targetUser: { id: 'u-2', name: 'Ben', image: null, role: 'USER' },
      }),
    ])

    const feed = await getFriendsFeed('viewer-1', 1)

    expect(feed.items).toHaveLength(1)
    expect(feed.items[0].type).toBe('follow')
    expect(feed.items[0].targetUser).toEqual({ id: 'u-2', name: 'Ben', image: null })
  })

  it('drops a follow row whose target user is banned', async () => {
    mockActivityFindMany.mockResolvedValue([
      activityRow({
        id: 'act-banned',
        type: 'follow',
        targetUserId: 'u-bad',
        targetUser: { id: 'u-bad', name: 'Mal', image: null, role: 'BANNED' },
      }),
      activityRow({
        id: 'act-ok',
        type: 'follow',
        targetUserId: 'u-2',
        targetUser: { id: 'u-2', name: 'Ben', image: null, role: 'USER' },
      }),
    ])

    const feed = await getFriendsFeed('viewer-1', 1)

    expect(feed.items.map((i) => i.id)).toEqual(['act-ok'])
  })
})

describe('getFriendsFeed: pagination', () => {
  it('over-fetches, trims survivors to the page size, and reports hasMore from a full window', async () => {
    const rows = Array.from({ length: FEED_PAGE_SIZE + 6 }, (_, i) =>
      activityRow({ id: `act-${i}`, type: 'watchlist', filmId: 'f-1' })
    )
    mockActivityFindMany.mockResolvedValue(rows)
    mockFilmFindMany.mockResolvedValue([FILM])

    const feed = await getFriendsFeed('viewer-1', 2)

    expect(mockActivityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: 'desc' },
        skip: FEED_PAGE_SIZE,
        take: FEED_PAGE_SIZE + 6,
      })
    )
    expect(feed.items).toHaveLength(FEED_PAGE_SIZE)
    expect(feed.page).toBe(2)
    expect(feed.hasMore).toBe(true)
  })

  it('reports hasMore: false when the raw window ends at the page boundary', async () => {
    const rows = Array.from({ length: FEED_PAGE_SIZE }, (_, i) =>
      activityRow({ id: `act-${i}`, type: 'watchlist', filmId: 'f-1' })
    )
    mockActivityFindMany.mockResolvedValue(rows)
    mockFilmFindMany.mockResolvedValue([FILM])

    const feed = await getFriendsFeed('viewer-1', 1)

    expect(feed.items).toHaveLength(FEED_PAGE_SIZE)
    expect(feed.hasMore).toBe(false)
  })

  it('reports hasMore from raw rows, not survivors: a dropped tail row still signals a next page', async () => {
    // 21 raw rows; the 21st sits exactly where page 2's skip starts, so
    // hasMore must be true even though that row drops at render time.
    const rows = Array.from({ length: FEED_PAGE_SIZE }, (_, i) =>
      activityRow({ id: `act-${i}`, type: 'watchlist', filmId: 'f-1' })
    )
    rows.push(activityRow({ id: 'act-dropped', type: 'watchlist', filmId: 'f-gone' }))
    mockActivityFindMany.mockResolvedValue(rows)
    mockFilmFindMany.mockResolvedValue([FILM])

    const feed = await getFriendsFeed('viewer-1', 1)

    expect(feed.items).toHaveLength(FEED_PAGE_SIZE)
    expect(feed.hasMore).toBe(true)
  })
})
