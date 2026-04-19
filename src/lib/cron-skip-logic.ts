/**
 * Daily sentiment-regen cron: decide whether a film should be skipped on a
 * given run. Pure function — the caller supplies already-resolved fields so
 * this can be exercised without touching the DB.
 *
 * A film skips regeneration when all three stability signals hold:
 *   - released at least MATURE_DAYS ago,
 *   - has at least QUALITY_REVIEW_THRESHOLD quality reviews, and
 *   - was regenerated within the last REGEN_INTERVAL_DAYS days.
 *
 * Any other state (pre-release, fresh release, thin coverage, stale graph,
 * or no graph at all) produces an eligibility result with a reason.
 */

export const MATURE_DAYS = 180
export const QUALITY_REVIEW_THRESHOLD = 17
export const REGEN_INTERVAL_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type CronSkipReason =
  | 'skipped_prerelease'
  | 'skipped_mature_stable'

export type CronEligibleReason =
  | 'eligible_no_graph'
  | 'eligible_recent_release'
  | 'eligible_thin_coverage'
  | 'eligible_stale_regen'

export type CronRegenDecision =
  | { skip: true; reason: CronSkipReason }
  | { skip: false; reason: CronEligibleReason }

export interface CronRegenInput {
  releaseDate: Date | null
  /** Count of quality reviews, per the isQualityReview filter. Callers may
   *  pass `film.lastReviewCount` as a proxy — it is populated by
   *  `storeSentimentGraphResult` with the filtered count at write time. */
  qualityReviewCount: number
  /** SentimentGraph.generatedAt, or null when the film has no graph yet. */
  lastRegenAt: Date | null
  now: Date
}

export function decideCronRegen(input: CronRegenInput): CronRegenDecision {
  if (input.releaseDate && input.releaseDate > input.now) {
    return { skip: true, reason: 'skipped_prerelease' }
  }

  if (!input.lastRegenAt) {
    return { skip: false, reason: 'eligible_no_graph' }
  }

  if (input.releaseDate) {
    const matureBoundary = new Date(input.now.getTime() - MATURE_DAYS * MS_PER_DAY)
    if (input.releaseDate > matureBoundary) {
      return { skip: false, reason: 'eligible_recent_release' }
    }
  }

  if (input.qualityReviewCount < QUALITY_REVIEW_THRESHOLD) {
    return { skip: false, reason: 'eligible_thin_coverage' }
  }

  const regenBoundary = new Date(input.now.getTime() - REGEN_INTERVAL_DAYS * MS_PER_DAY)
  if (input.lastRegenAt <= regenBoundary) {
    return { skip: false, reason: 'eligible_stale_regen' }
  }

  return { skip: true, reason: 'skipped_mature_stable' }
}
