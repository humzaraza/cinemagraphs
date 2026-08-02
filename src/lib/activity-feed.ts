import { prisma } from './prisma'

export const FEED_PAGE_SIZE = 20

// Referent resolution below can drop rows (deleted review, missing film,
// private or deleted list). Over-fetch a few extra rows per page so a page
// with a handful of dropped rows still usually renders full.
const FEED_OVERFETCH = 6

// Feed-visible activity types. Likes and replies are deliberately excluded
// from the friends feed.
const FEED_TYPES = ['review', 'follow', 'watchlist', 'list_add']

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
  type: 'review' | 'follow' | 'watchlist' | 'list_add'
  createdAt: string
  actor: FeedActor
  targetUser: FeedActor | null
  film: FeedFilm | null
  review: { id: string } | null
  list: FeedList | null
}

export interface FriendsFeedPage {
  items: FeedItem[]
  page: number
  hasMore: boolean
}

function uniqueIds(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id != null))]
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
