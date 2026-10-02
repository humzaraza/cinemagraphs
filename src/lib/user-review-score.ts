/**
 * The score shown on a user's own review.
 *
 *   reviewScore = round1( 0.5 * mean(beat ratings the user set) + 0.5 * overallRating )
 *   reviewScore = overallRating                      when no beats were rated
 *
 * Both inputs are on the 1 to 10 scale, so the result is too. This number is
 * for the review itself only: the film's audience graph and score are built
 * from beat ratings alone, and the overall slider never feeds them.
 *
 * Pure and dependency-free so the same helper serves server components, API
 * routes, the share poster, and JSON-LD.
 */
export function userReviewScore(
  overallRating: number,
  beatRatings: Record<string, unknown> | null | undefined
): number {
  const beats = beatRatings
    ? Object.values(beatRatings).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    : []
  if (beats.length === 0) return overallRating
  const beatMean = beats.reduce((sum, v) => sum + v, 0) / beats.length
  return Math.round((0.5 * beatMean + 0.5 * overallRating) * 10) / 10
}

/** Mean of userReviewScore across a set of reviews, rounded to one decimal,
 *  or null when there are none. Used for the community average and the
 *  JSON-LD aggregate rating. */
export function averageUserReviewScore(
  reviews: ReadonlyArray<{ overallRating: number; beatRatings: Record<string, unknown> | null | undefined }>
): number | null {
  if (reviews.length === 0) return null
  const total = reviews.reduce((sum, r) => sum + userReviewScore(r.overallRating, r.beatRatings), 0)
  return Math.round((total / reviews.length) * 10) / 10
}
