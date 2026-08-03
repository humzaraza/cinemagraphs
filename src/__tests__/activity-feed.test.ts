import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFollowFindMany = vi.fn()
const mockActivityFindMany = vi.fn()
const mockUserReviewFindMany = vi.fn()
const mockFilmFindMany = vi.fn()
const mockListFindMany = vi.fn()
const mockReviewReplyFindMany = vi.fn()
const mockUserFindUnique = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    follow: {
      findMany: (...args: unknown[]) => mockFollowFindMany(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
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
    reviewReply: {
      findMany: (...args: unknown[]) => mockReviewReplyFindMany(...args),
    },
  },
}))

import {
  getFriendsFeed,
  getIncomingFeed,
  hasUnreadIncoming,
  FEED_PAGE_SIZE,
} from '@/lib/activity-feed'

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
  mockReviewReplyFindMany.mockResolvedValue([])
  mockUserFindUnique.mockResolvedValue({ lastSeenActivityAt: null })
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
        reply: null,
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

const INCOMING_ACTOR = { id: 'u-2', name: 'Ben', image: null, role: 'USER' }

function incomingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act-in-1',
    actorId: 'u-2',
    type: 'follow',
    createdAt: new Date('2026-08-01T12:00:00Z'),
    targetUserId: 'viewer-1',
    reviewId: null,
    filmId: null,
    replyId: null,
    listId: null,
    actor: INCOMING_ACTOR,
    ...overrides,
  }
}

describe('getIncomingFeed: query scoping', () => {
  it('targets the viewer and excludes self-targeted rows via the actorId filter', async () => {
    await getIncomingFeed('viewer-1', 1)

    expect(mockActivityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          targetUserId: 'viewer-1',
          type: { in: ['follow', 'like', 'reply', 'reply_to_comment'] },
          actorId: { not: 'viewer-1' },
        },
      })
    )
  })

  it('requests only follow, like, reply, and reply_to_comment types', async () => {
    await getIncomingFeed('viewer-1', 1)

    const where = mockActivityFindMany.mock.calls[0][0].where
    expect(where.type.in).toEqual(['follow', 'like', 'reply', 'reply_to_comment'])
    expect(where.type.in).not.toContain('review')
    expect(where.type.in).not.toContain('watchlist')
    expect(where.type.in).not.toContain('list_add')
  })
})

describe('getIncomingFeed: referent resolution and dropping', () => {
  it('shapes a follow row from the actor alone, stripping the internal role field', async () => {
    mockActivityFindMany.mockResolvedValue([incomingRow({ id: 'act-f', type: 'follow' })])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items).toEqual([
      {
        id: 'act-f',
        type: 'follow',
        createdAt: '2026-08-01T12:00:00.000Z',
        actor: { id: 'u-2', name: 'Ben', image: null },
        targetUser: null,
        film: null,
        review: null,
        list: null,
        reply: null,
      },
    ])
  })

  it('drops rows whose actor is banned', async () => {
    mockActivityFindMany.mockResolvedValue([
      incomingRow({
        id: 'act-banned',
        actorId: 'u-bad',
        actor: { id: 'u-bad', name: 'Mal', image: null, role: 'BANNED' },
      }),
      incomingRow({ id: 'act-ok' }),
    ])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items.map((i) => i.id)).toEqual(['act-ok'])
  })

  it('keeps a like row whose review is approved and shapes it with the review film', async () => {
    mockActivityFindMany.mockResolvedValue([
      incomingRow({ id: 'act-l', type: 'like', reviewId: 'r-1' }),
    ])
    mockUserReviewFindMany.mockResolvedValue([{ id: 'r-1', film: FILM }])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items).toHaveLength(1)
    expect(feed.items[0].type).toBe('like')
    expect(feed.items[0].review).toEqual({ id: 'r-1' })
    expect(feed.items[0].film).toEqual(FILM)
    // The status filter is applied in the query itself.
    expect(mockUserReviewFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['r-1'] }, status: 'approved' },
      })
    )
  })

  it('drops a like row whose review is not approved', async () => {
    mockActivityFindMany.mockResolvedValue([
      incomingRow({ id: 'act-l', type: 'like', reviewId: 'r-flagged' }),
    ])
    // The status: 'approved' filter means a flagged review comes back empty.
    mockUserReviewFindMany.mockResolvedValue([])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items).toEqual([])
  })

  it('keeps a reply row and truncates its body to the preview length', async () => {
    mockActivityFindMany.mockResolvedValue([
      incomingRow({ id: 'act-rp', type: 'reply', reviewId: 'r-1', replyId: 'rr-1' }),
    ])
    mockUserReviewFindMany.mockResolvedValue([{ id: 'r-1', film: FILM }])
    mockReviewReplyFindMany.mockResolvedValue([{ id: 'rr-1', body: 'x'.repeat(300) }])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items).toHaveLength(1)
    expect(feed.items[0].type).toBe('reply')
    expect(feed.items[0].review).toEqual({ id: 'r-1' })
    expect(feed.items[0].film).toEqual(FILM)
    expect(feed.items[0].reply).toEqual({ id: 'rr-1', body: `${'x'.repeat(120)}…` })
  })

  it('does not split a surrogate pair at the truncation boundary', async () => {
    // 119 ASCII chars + an astral emoji = 121 UTF-16 code units, so a naive
    // slice(0, 120) would cut between the high and low surrogate.
    mockActivityFindMany.mockResolvedValue([
      incomingRow({ id: 'act-rp', type: 'reply', reviewId: 'r-1', replyId: 'rr-1' }),
    ])
    mockUserReviewFindMany.mockResolvedValue([{ id: 'r-1', film: FILM }])
    mockReviewReplyFindMany.mockResolvedValue([{ id: 'rr-1', body: `${'a'.repeat(119)}😀` }])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items[0].reply).toEqual({ id: 'rr-1', body: `${'a'.repeat(119)}…` })
  })

  it('leaves a short reply body untouched', async () => {
    mockActivityFindMany.mockResolvedValue([
      incomingRow({ id: 'act-rp', type: 'reply', reviewId: 'r-1', replyId: 'rr-1' }),
    ])
    mockUserReviewFindMany.mockResolvedValue([{ id: 'r-1', film: FILM }])
    mockReviewReplyFindMany.mockResolvedValue([{ id: 'rr-1', body: 'Great catch on the score.' }])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items[0].reply).toEqual({ id: 'rr-1', body: 'Great catch on the score.' })
  })

  it('drops a reply row whose reply was hard-deleted even though its review resolves', async () => {
    mockActivityFindMany.mockResolvedValue([
      incomingRow({ id: 'act-rp', type: 'reply', reviewId: 'r-1', replyId: 'rr-gone' }),
    ])
    mockUserReviewFindMany.mockResolvedValue([{ id: 'r-1', film: FILM }])
    mockReviewReplyFindMany.mockResolvedValue([])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items).toEqual([])
  })

  it('drops a reply row whose review is gone even though its reply resolves', async () => {
    mockActivityFindMany.mockResolvedValue([
      incomingRow({ id: 'act-rp', type: 'reply', reviewId: 'r-gone', replyId: 'rr-1' }),
    ])
    mockUserReviewFindMany.mockResolvedValue([])
    mockReviewReplyFindMany.mockResolvedValue([{ id: 'rr-1', body: 'Orphaned.' }])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items).toEqual([])
  })

  it('keeps a reply_to_comment row, preserving its type and truncating its body', async () => {
    mockActivityFindMany.mockResolvedValue([
      incomingRow({ id: 'act-rtc', type: 'reply_to_comment', reviewId: 'r-1', replyId: 'rr-1' }),
    ])
    mockUserReviewFindMany.mockResolvedValue([{ id: 'r-1', film: FILM }])
    mockReviewReplyFindMany.mockResolvedValue([{ id: 'rr-1', body: 'x'.repeat(300) }])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items).toHaveLength(1)
    expect(feed.items[0].type).toBe('reply_to_comment')
    expect(feed.items[0].review).toEqual({ id: 'r-1' })
    expect(feed.items[0].film).toEqual(FILM)
    expect(feed.items[0].reply).toEqual({ id: 'rr-1', body: `${'x'.repeat(120)}…` })
  })

  it('drops a reply_to_comment row whose reply was hard-deleted', async () => {
    mockActivityFindMany.mockResolvedValue([
      incomingRow({ id: 'act-rtc', type: 'reply_to_comment', reviewId: 'r-1', replyId: 'rr-gone' }),
    ])
    mockUserReviewFindMany.mockResolvedValue([{ id: 'r-1', film: FILM }])
    mockReviewReplyFindMany.mockResolvedValue([])

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items).toEqual([])
  })
})

describe('getIncomingFeed: pagination', () => {
  it('over-fetches, trims survivors to the page size, and reports hasMore from a full window', async () => {
    const rows = Array.from({ length: FEED_PAGE_SIZE + 6 }, (_, i) =>
      incomingRow({ id: `act-${i}` })
    )
    mockActivityFindMany.mockResolvedValue(rows)

    const feed = await getIncomingFeed('viewer-1', 2)

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
    const rows = Array.from({ length: FEED_PAGE_SIZE }, (_, i) => incomingRow({ id: `act-${i}` }))
    mockActivityFindMany.mockResolvedValue(rows)

    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed.items).toHaveLength(FEED_PAGE_SIZE)
    expect(feed.hasMore).toBe(false)
  })

  it('returns the empty shape when nothing targets the viewer', async () => {
    const feed = await getIncomingFeed('viewer-1', 1)

    expect(feed).toEqual({ items: [], page: 1, hasMore: false })
  })
})

describe('hasUnreadIncoming', () => {
  it('is true when a qualifying row exists after lastSeenActivityAt, filtered in the query', async () => {
    const lastSeen = new Date('2026-07-30T00:00:00Z')
    mockUserFindUnique.mockResolvedValue({ lastSeenActivityAt: lastSeen })
    mockActivityFindMany.mockResolvedValue([incomingRow({ id: 'act-new' })])

    await expect(hasUnreadIncoming('viewer-1')).resolves.toBe(true)

    expect(mockUserFindUnique).toHaveBeenCalledWith({
      where: { id: 'viewer-1' },
      select: { lastSeenActivityAt: true },
    })
    expect(mockActivityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          targetUserId: 'viewer-1',
          type: { in: ['follow', 'like', 'reply', 'reply_to_comment'] },
          actorId: { not: 'viewer-1' },
          createdAt: { gt: lastSeen },
        },
        skip: 0,
      })
    )
  })

  it('is false when lastSeenActivityAt is newer than all rows', async () => {
    const lastSeen = new Date('2026-08-02T00:00:00Z')
    mockUserFindUnique.mockResolvedValue({ lastSeenActivityAt: lastSeen })
    // The createdAt > lastSeen filter excludes every row at the query level.
    mockActivityFindMany.mockResolvedValue([])

    await expect(hasUnreadIncoming('viewer-1')).resolves.toBe(false)

    const where = mockActivityFindMany.mock.calls[0][0].where
    expect(where.createdAt).toEqual({ gt: lastSeen })
  })

  it('treats a null lastSeenActivityAt as everything unread, omitting the createdAt filter', async () => {
    mockUserFindUnique.mockResolvedValue({ lastSeenActivityAt: null })
    mockActivityFindMany.mockResolvedValue([incomingRow({ id: 'act-old' })])

    await expect(hasUnreadIncoming('viewer-1')).resolves.toBe(true)

    const where = mockActivityFindMany.mock.calls[0][0].where
    expect(where).not.toHaveProperty('createdAt')
  })

  it('is false when every candidate row would be dropped by the feed (banned actor, unapproved review, deleted reply)', async () => {
    // The invariant that matters: a row only counts as unread if the
    // Incoming tab would actually render it, so the dot never points at
    // an empty tab.
    mockActivityFindMany.mockResolvedValue([
      incomingRow({
        id: 'act-banned',
        actorId: 'u-bad',
        actor: { id: 'u-bad', name: 'Mal', image: null, role: 'BANNED' },
      }),
      incomingRow({ id: 'act-like', type: 'like', reviewId: 'r-flagged' }),
      incomingRow({ id: 'act-reply', type: 'reply', reviewId: 'r-1', replyId: 'rr-gone' }),
    ])
    // r-flagged is not approved so only r-1 resolves; rr-gone was
    // hard-deleted so the reply referent is missing.
    mockUserReviewFindMany.mockResolvedValue([{ id: 'r-1', film: FILM }])
    mockReviewReplyFindMany.mockResolvedValue([])

    await expect(hasUnreadIncoming('viewer-1')).resolves.toBe(false)

    // Pin the approved-status filter on this path too: the drop above only
    // proves anything if the query itself is what excludes flagged reviews.
    expect(mockUserReviewFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['r-flagged', 'r-1'] }, status: 'approved' },
      })
    )
  })

  it('treats a missing viewer row like a null lastSeenActivityAt', async () => {
    mockUserFindUnique.mockResolvedValue(null)
    mockActivityFindMany.mockResolvedValue([incomingRow({ id: 'act-any' })])

    await expect(hasUnreadIncoming('viewer-1')).resolves.toBe(true)

    const where = mockActivityFindMany.mock.calls[0][0].where
    expect(where).not.toHaveProperty('createdAt')
  })

  it('is false when the only rows are self-targeted, excluded via the actorId filter', async () => {
    // Self-targeted rows never leave the database: the query carries the
    // same actorId exclusion as getIncomingFeed, so they cannot count as
    // unread any more than they can render.
    mockActivityFindMany.mockResolvedValue([])

    await expect(hasUnreadIncoming('viewer-1')).resolves.toBe(false)

    expect(mockActivityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorId: { not: 'viewer-1' } }),
      })
    )
  })
})
