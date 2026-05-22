import { prisma } from '@/lib/prisma'
import type { SentimentDataPoint } from '@/lib/types'

/**
 * Shared data-access for the film detail page and its sibling API routes.
 *
 * The film detail page (a Server Component) and the
 * /api/films/[id]/reviews, /audience-data and /watchlist route handlers
 * need the same queries. These functions are the single source of truth:
 * the page calls them directly during the server render (and caches the
 * public ones), while the route handlers wrap them so the mobile app and
 * the "load more" pagination keep working unchanged.
 *
 * PUBLIC functions return the same data for every viewer and are safe to
 * cache per film id. PER-USER functions depend on the signed-in user and
 * must never be cached.
 */

const REVIEWS_PAGE_SIZE = 5

const reviewUserSelect = { select: { id: true, name: true, image: true } } as const

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/**
 * One page of approved reviews for a film plus the community summary.
 *
 * `excludeUserId`, when set, drops that user's reviews from the paginated
 * list and its count. This is the mobile "your review" pattern, where the
 * caller renders the current user's own review in a separate section and
 * wants it omitted from the list to avoid duplication. The community
 * summary is always computed over every approved review, regardless of
 * exclusion.
 *
 * PUBLIC when `excludeUserId` is null (the detail page always calls it
 * that way). With an `excludeUserId` the list varies per user, so that
 * variant must not be cached.
 */
export async function getFilmReviewsPage(
  filmId: string,
  page = 1,
  excludeUserId: string | null = null,
) {
  const limit = REVIEWS_PAGE_SIZE
  const approvedFilter = { filmId, status: 'approved' }
  const listFilter =
    excludeUserId !== null
      ? { ...approvedFilter, userId: { not: excludeUserId } }
      : approvedFilter

  const [reviews, total] = await Promise.all([
    prisma.userReview.findMany({
      where: listFilter,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { user: reviewUserSelect },
    }),
    prisma.userReview.count({ where: listFilter }),
  ])

  // Community summary (approved only): computed over every approved
  // review, never the per-user exclusion filter.
  const allReviews = await prisma.userReview.findMany({
    where: approvedFilter,
    select: { overallRating: true, sentiment: true, beginning: true, middle: true, ending: true },
  })

  const avgRating =
    allReviews.length > 0
      ? Math.round(
          (allReviews.reduce((sum, r) => sum + r.overallRating, 0) / allReviews.length) * 10,
        ) / 10
      : null

  const distribution = Array.from({ length: 10 }, (_, i) => ({
    score: i + 1,
    count: allReviews.filter((r) => Math.round(r.overallRating) === i + 1).length,
  }))

  const withBeginning = allReviews.filter((r) => r.beginning)
  const withMiddle = allReviews.filter((r) => r.middle)
  const withEnding = allReviews.filter((r) => r.ending)

  return {
    reviews,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    summary: {
      avgRating,
      totalReviews: total,
      distribution,
      sectionCounts: {
        beginning: withBeginning.length,
        middle: withMiddle.length,
        ending: withEnding.length,
      },
    },
  }
}

/**
 * The signed-in user's own review for a film, at any moderation status, or
 * null when they have not reviewed it. PER-USER: never cache.
 */
export async function getUserReviewForFilm(filmId: string, userId: string) {
  return prisma.userReview.findUnique({
    where: { userId_filmId: { userId, filmId } },
    include: { user: reviewUserSelect },
  })
}

// ---------------------------------------------------------------------------
// Audience data
// ---------------------------------------------------------------------------

export interface FilmAudienceData {
  userReviewCount: number
  beatAverages: Record<string, number>
  liveSessionCount: number
  reactionScores: { index: number; score: number }[]
}

/**
 * Aggregate audience signals for a film's sentiment graph: averaged beat
 * ratings from approved user reviews, the count of quality live-reaction
 * sessions, and (only once 20+ quality sessions exist) time-bucketed
 * reaction scores. PUBLIC: identical for every viewer.
 */
export async function getFilmAudienceData(filmId: string): Promise<FilmAudienceData> {
  // Approved user reviews with beat ratings
  const reviews = await prisma.userReview.findMany({
    where: { filmId, status: 'approved' },
    select: { beatRatings: true, overallRating: true },
  })

  // Average beat ratings per label
  const beatTotals: Record<string, { total: number; count: number }> = {}
  for (const review of reviews) {
    if (!review.beatRatings) continue
    const ratings = review.beatRatings as Record<string, number>
    for (const [label, score] of Object.entries(ratings)) {
      if (!beatTotals[label]) beatTotals[label] = { total: 0, count: 0 }
      beatTotals[label].total += score
      beatTotals[label].count++
    }
  }
  const beatAverages: Record<string, number> = {}
  for (const [label, { total, count }] of Object.entries(beatTotals)) {
    beatAverages[label] = Math.round((total / count) * 10) / 10
  }

  // Quality live reaction sessions (50%+ completion, not flagged)
  const liveSessionCount = await prisma.liveReactionSession.count({
    where: { filmId, completionRate: { gte: 0.5 }, flagged: false },
  })

  // Aggregate live reactions into time-bucketed scores (normalized to 1-10 scale)
  let reactionScores: { index: number; score: number }[] = []
  if (liveSessionCount >= 20) {
    const qualitySessions = await prisma.liveReactionSession.findMany({
      where: { filmId, completionRate: { gte: 0.5 }, flagged: false },
      select: { id: true },
    })
    const sessionIds = qualitySessions.map((s) => s.id)

    const reactions = await prisma.liveReaction.findMany({
      where: {
        filmId,
        OR: [{ sessionId: { in: sessionIds } }, { sessionId: null }],
      },
      select: { score: true, sessionTimestamp: true },
    })

    const graph = await prisma.sentimentGraph.findUnique({
      where: { filmId },
      select: { dataPoints: true },
    })

    if (graph?.dataPoints) {
      const dps = graph.dataPoints as unknown as SentimentDataPoint[]
      const buckets: Record<number, { total: number; count: number }> = {}

      for (const reaction of reactions) {
        const minutes = reaction.sessionTimestamp / 60
        for (let i = 0; i < dps.length; i++) {
          if (minutes >= dps[i].timeStart && minutes <= dps[i].timeEnd) {
            if (!buckets[i]) buckets[i] = { total: 0, count: 0 }
            buckets[i].total += reaction.score
            buckets[i].count++
            break
          }
        }
      }

      // Normalize reaction averages to 1-10 scale (centered at 5)
      reactionScores = Object.entries(buckets).map(([i, b]) => ({
        index: Number(i),
        score: Math.max(1, Math.min(10, 5 + (b.total / b.count) * 5)),
      }))
    }
  }

  return {
    userReviewCount: reviews.length,
    beatAverages,
    liveSessionCount,
    reactionScores,
  }
}

// ---------------------------------------------------------------------------
// Watchlist status
// ---------------------------------------------------------------------------

/**
 * Whether `userId` has `filmId` in their watchlist. PER-USER: never cache.
 */
export async function getWatchlistStatus(filmId: string, userId: string): Promise<boolean> {
  const item = await prisma.watchlist.findUnique({
    where: { userId_filmId: { userId, filmId } },
  })
  return item !== null
}
