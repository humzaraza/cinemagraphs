import { prisma } from './prisma'

export const FEED_PAGE_SIZE = 20

// Referent resolution below can drop rows (deleted review, missing film,
// private or deleted list). Over-fetch a few extra rows per page so a page
// with a handful of dropped rows still usually renders full.
const FEED_OVERFETCH = 6

// Feed-visible activity types. Likes and replies are deliberately excluded
// from the friends feed.
const FEED_TYPES = ['review', 'follow', 'watchlist', 'list_add']

// Incoming (notifications) types: activity that targeted the viewer.
const INCOMING_TYPES = ['follow', 'like', 'reply']

// Reply bodies are previews in the feed, not full threads; truncation happens
// here in the shaping step so every client renders the same preview.
const REPLY_PREVIEW_LENGTH = 120

export interface FeedActor {
  id: string
  name: string | null
  image: string | null
}

export interface FeedFilm {
  id: string
  title: string
  posterUrl: string | null
}

export interface FeedList {
  id: string
  name: string
}

export interface FeedItem {
  id: string
  type: 'review' | 'follow' | 'watchlist' | 'list_add' | 'like' | 'reply'
  createdAt: string
  actor: FeedActor
  targetUser: FeedActor | null
  film: FeedFilm | null
  review: { id: string } | null
  list: FeedList | null
  reply: { id: string; body: string } | null
}

export interface FriendsFeedPage {
  items: FeedItem[]
  page: number
  hasMore: boolean
}

function uniqueIds(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id != null))]
}

function truncateReplyBody(body: string): string {
  if (body.length <= REPLY_PREVIEW_LENGTH) return body
  const cut = body.slice(0, REPLY_PREVIEW_LENGTH)
  // slice counts UTF-16 code units, so the boundary can land inside a
  // surrogate pair; drop a trailing high surrogate rather than emit U+FFFD.
  const wellFormed = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
  return `${wellFormed.trimEnd()}…`
}

/**
 * Friends activity feed: recent activity by users the viewer follows.
 *
 * Not Redis-cached: per-user data. Referents are batch-resolved and rows
 * whose referent is gone are dropped, following the hydrateFavoriteFilms
 * precedent in profile-response.ts. The status/isPublic filters are load
 * bearing: a review flagged after logging and films on private lists must
 * never render in someone else's feed.
 */
export async function getFriendsFeed(viewerId: string, page: number): Promise<FriendsFeedPage> {
  // Banned members are excluded at the follow-resolution step (matching
  // /api/users/search), so their ids never enter the actor scope below.
  const follows = await prisma.follow.findMany({
    where: { followerId: viewerId, following: { role: { not: 'BANNED' } } },
    select: { followingId: true },
  })
  const followedIds = follows.map((f) => f.followingId)
  if (followedIds.length === 0) {
    return { items: [], page, hasMore: false }
  }

  const rows = await prisma.activity.findMany({
    where: {
      actorId: { in: followedIds },
      type: { in: FEED_TYPES },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * FEED_PAGE_SIZE,
    take: FEED_PAGE_SIZE + FEED_OVERFETCH,
    include: {
      actor: { select: { id: true, name: true, image: true } },
      // role is an internal filter input for the follow branch below; it is
      // stripped before the item is shaped and never leaves this module.
      targetUser: { select: { id: true, name: true, image: true, role: true } },
    },
  })

  const reviewIds = uniqueIds(rows.map((r) => r.reviewId))
  const filmIds = uniqueIds(rows.map((r) => r.filmId))
  const listIds = uniqueIds(rows.map((r) => r.listId))

  const [reviews, films, lists] = await Promise.all([
    reviewIds.length
      ? prisma.userReview.findMany({
          where: { id: { in: reviewIds }, status: 'approved' },
          select: {
            id: true,
            user: { select: { id: true, name: true, image: true } },
            film: { select: { id: true, title: true, posterUrl: true } },
          },
        })
      : [],
    filmIds.length
      ? prisma.film.findMany({
          where: { id: { in: filmIds } },
          select: { id: true, title: true, posterUrl: true },
        })
      : [],
    listIds.length
      ? prisma.list.findMany({
          where: { id: { in: listIds }, isPublic: true },
          select: { id: true, name: true },
        })
      : [],
  ])

  const reviewById = new Map(reviews.map((r) => [r.id, r]))
  const filmById = new Map(films.map((f) => [f.id, f]))
  const listById = new Map(lists.map((l) => [l.id, l]))

  const items = rows
    .flatMap((row): FeedItem[] => {
      const base = {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        actor: row.actor,
        targetUser: null,
        film: null,
        review: null,
        list: null,
        reply: null,
      }
      switch (row.type) {
        case 'review': {
          const review = row.reviewId ? reviewById.get(row.reviewId) : undefined
          if (!review) return []
          return [{ ...base, type: 'review', review: { id: review.id }, film: review.film }]
        }
        case 'follow': {
          // A banned target must not render, mirroring the approved-review
          // drop and the actor-scope filter above.
          if (!row.targetUser || row.targetUser.role === 'BANNED') return []
          const { id, name, image } = row.targetUser
          return [{ ...base, type: 'follow', targetUser: { id, name, image } }]
        }
        case 'watchlist': {
          const film = row.filmId ? filmById.get(row.filmId) : undefined
          if (!film) return []
          return [{ ...base, type: 'watchlist', film }]
        }
        case 'list_add': {
          const film = row.filmId ? filmById.get(row.filmId) : undefined
          const list = row.listId ? listById.get(row.listId) : undefined
          if (!film || !list) return []
          return [{ ...base, type: 'list_add', film, list }]
        }
        default:
          return []
      }
    })
    .slice(0, FEED_PAGE_SIZE)

  // hasMore is derived from the raw fetch window rather than a count query:
  // rows past FEED_PAGE_SIZE sit exactly where the next page's skip starts,
  // so their presence means a further fetch returns raw rows. This covers
  // both a full window (more rows may exist beyond it) and a partial tail
  // (rows 21..26 that this page's trim left for the next fetch). Checking
  // for a completely full window, or for surplus survivors, would each
  // strand reachable tail rows. A count query here would leak the volume
  // of suppressed activity (private lists, flagged reviews) to the viewer,
  // which is why total/totalPages are gone.
  const hasMore = rows.length > FEED_PAGE_SIZE

  return { items, page, hasMore }
}

/**
 * Incoming feed: activity by others that targeted the viewer (new followers,
 * likes and replies on the viewer's reviews).
 *
 * Not Redis-cached: per-user data. Same referent-resolution-and-drop pattern
 * as getFriendsFeed. The actorId exclusion is load bearing: the reply route
 * logs a row even when the replier is the review author, so self-targeted
 * rows exist in the table and must never render as notifications. Banned
 * actors are filtered per row here because Incoming has no follow-resolution
 * step to filter them upstream.
 */
export async function getIncomingFeed(viewerId: string, page: number): Promise<FriendsFeedPage> {
  const rows = await prisma.activity.findMany({
    where: {
      targetUserId: viewerId,
      type: { in: INCOMING_TYPES },
      actorId: { not: viewerId },
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * FEED_PAGE_SIZE,
    take: FEED_PAGE_SIZE + FEED_OVERFETCH,
    include: {
      // role is an internal filter input for the banned drop below; it is
      // stripped before the item is shaped and never leaves this module.
      actor: { select: { id: true, name: true, image: true, role: true } },
    },
  })

  const reviewIds = uniqueIds(rows.map((r) => r.reviewId))
  const replyIds = uniqueIds(rows.map((r) => r.replyId))

  const [reviews, replies] = await Promise.all([
    reviewIds.length
      ? prisma.userReview.findMany({
          where: { id: { in: reviewIds }, status: 'approved' },
          select: {
            id: true,
            film: { select: { id: true, title: true, posterUrl: true } },
          },
        })
      : [],
    replyIds.length
      ? prisma.reviewReply.findMany({
          where: { id: { in: replyIds } },
          select: { id: true, body: true },
        })
      : [],
  ])

  const reviewById = new Map(reviews.map((r) => [r.id, r]))
  const replyById = new Map(replies.map((r) => [r.id, r]))

  const items = rows
    .flatMap((row): FeedItem[] => {
      if (row.actor.role === 'BANNED') return []
      const base = {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        actor: { id: row.actor.id, name: row.actor.name, image: row.actor.image },
        targetUser: null,
        film: null,
        review: null,
        list: null,
        reply: null,
      }
      switch (row.type) {
        case 'follow':
          return [{ ...base, type: 'follow' }]
        case 'like': {
          const review = row.reviewId ? reviewById.get(row.reviewId) : undefined
          if (!review) return []
          return [{ ...base, type: 'like', review: { id: review.id }, film: review.film }]
        }
        case 'reply': {
          const review = row.reviewId ? reviewById.get(row.reviewId) : undefined
          // Reply deletion is a hard delete that leaves the activity row
          // behind, so a resolved review is not enough on its own.
          const reply = row.replyId ? replyById.get(row.replyId) : undefined
          if (!review || !reply) return []
          return [
            {
              ...base,
              type: 'reply',
              review: { id: review.id },
              film: review.film,
              reply: { id: reply.id, body: truncateReplyBody(reply.body) },
            },
          ]
        }
        default:
          return []
      }
    })
    .slice(0, FEED_PAGE_SIZE)

  // Same raw-window derivation as getFriendsFeed; see the comment there.
  const hasMore = rows.length > FEED_PAGE_SIZE

  return { items, page, hasMore }
}
