import { cache } from 'react'
import { prisma } from '@/lib/prisma'
import { publicReviewSelect } from '@/lib/film-detail'

/**
 * The one review visibility rule, shared by every surface that reads a
 * single review: the page at /reviews/[id] and GET /api/reviews/[id].
 *
 * An approved review is public and resolves for any viewer, signed in or
 * not. Any other status (flagged, rejected, or anything added later)
 * resolves only for the review's author, so a moderated review stays
 * readable to the person who wrote it and to nobody else. A viewer with no
 * id is never an author, so they see approved reviews only.
 *
 * Callers must turn a false into the same 404 a missing id produces, never
 * a 403 and never a distinct message: a distinguishable response would
 * reveal that a hidden review exists at that id.
 */
export function canViewReview(
  status: string,
  authorId: string,
  viewerId: string | null
): boolean {
  if (status === 'approved') return true
  // Falsy, not just non-null: an empty-string viewer id must never match an
  // empty-string author id into ownership of a hidden review.
  if (!viewerId) return false
  return viewerId === authorId
}

/**
 * Shared data-access for the standalone review page (/reviews/[id]).
 *
 * One review by id with its public author fields (same shape as
 * reviewUserSelect in film-detail.ts) and the film context the page
 * renders, or null when no review has that id.
 *
 * `status` and `userId` are selected on top of publicReviewSelect solely so
 * the caller can run canViewReview. Both are moderation/internal fields:
 * destructure them off before rendering anything. publicReviewSelect itself
 * stays narrow for its other callers.
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
    select: {
      ...publicReviewSelect,
      status: true,
      userId: true,
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
