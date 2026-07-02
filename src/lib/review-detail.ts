import { cache } from 'react'
import { prisma } from '@/lib/prisma'

/**
 * Shared data-access for the standalone review page (/reviews/[id]).
 *
 * One review by id with its public author fields (same shape as
 * reviewUserSelect in film-detail.ts) and the film context the page
 * renders, or null when no review has that id.
 *
 * No status filter: reviews currently go live as 'approved' on create and
 * on edit (AUTO_MODERATION_ENABLED is off in the reviews POST route), so a
 * review link is meant to resolve whenever the review exists.
 *
 * PUBLIC read, deliberately NOT Redis-cached: review edits and deletes
 * invalidate through invalidateFilmCache(filmId), which clears film-keyed
 * entries only. A review-keyed cache entry would survive those mutations
 * and serve a stale review after an edit or a 200 after a delete.
 * Correctness over caching; revisit if this page grows a review-keyed
 * invalidation path.
 *
 * Wrapped in React cache() (same pattern as person-data.ts) so
 * generateMetadata and the page render share a single query per request.
 */
export const getReviewById = cache(async (reviewId: string) => {
  return prisma.userReview.findUnique({
    where: { id: reviewId },
    include: {
      user: { select: { id: true, name: true, image: true } },
      film: {
        select: {
          id: true,
          title: true,
          posterUrl: true,
          backdropUrl: true,
          releaseDate: true,
          director: true,
          runtime: true,
          sentimentGraph: { select: { dataPoints: true } },
        },
      },
    },
  })
})
