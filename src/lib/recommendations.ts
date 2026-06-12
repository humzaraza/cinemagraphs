// Pure scoring logic for the Recommended for You endpoint. No Prisma imports:
// the route queries seeds and edges and passes plain rows in, so everything
// here is unit-testable without a database.

/** Minimum review count before any recommendations are produced. */
export const MIN_REVIEWS = 5
/** Ratings at or below this contribute zero seed weight. */
export const SEED_WEIGHT_FLOOR = 5
/** Seeds rated at or above this contribute their arc tags to the boost set. */
export const ARC_SEED_MIN_RATING = 7
export const ARC_BOOST_PER_TAG = 0.1
export const ARC_BOOST_CAP = 0.2
/** Candidates hydrated before the arc boost re-rank. */
export const BASE_POOL = 40
/** Films returned to the client. */
export const RESULT_LIMIT = 20

export interface RecommendationSeed {
  filmId: string
  overallRating: number
}

export interface ArcSeed extends RecommendationSeed {
  arcShape: string[]
}

export interface SimilarityEdge {
  filmId: string
  similarFilmId: string
  similarityScore: number
}

/**
 * Weight a seed contributes per edge. Ratings at or below
 * SEED_WEIGHT_FLOOR contribute nothing; a 10 contributes 5.
 */
export function seedWeight(overallRating: number): number {
  return Math.max(0, overallRating - SEED_WEIGHT_FLOOR)
}

/**
 * Accumulate candidate scores from similarity edges. For each edge whose
 * source is a seed with positive weight, the target gains
 * weight * similarityScore; targets in `excludedFilmIds` (everything the
 * user has reviewed) never enter the map. Edges whose source is not a seed
 * are ignored.
 */
export function scoreCandidates(
  seeds: RecommendationSeed[],
  edges: SimilarityEdge[],
  excludedFilmIds: Set<string>,
): Map<string, number> {
  const weights = new Map<string, number>()
  for (const seed of seeds) {
    const weight = seedWeight(seed.overallRating)
    if (weight > 0) weights.set(seed.filmId, weight)
  }

  const totals = new Map<string, number>()
  for (const edge of edges) {
    const weight = weights.get(edge.filmId)
    if (weight === undefined) continue
    if (excludedFilmIds.has(edge.similarFilmId)) continue
    const current = totals.get(edge.similarFilmId) ?? 0
    totals.set(edge.similarFilmId, current + weight * edge.similarityScore)
  }
  return totals
}

/**
 * Union of arcShape tags across seeds rated at or above ARC_SEED_MIN_RATING.
 * Lower-rated seeds say nothing about which arcs the user likes.
 */
export function preferredArcTags(seeds: ArcSeed[]): Set<string> {
  const tags = new Set<string>()
  for (const seed of seeds) {
    if (seed.overallRating < ARC_SEED_MIN_RATING) continue
    for (const tag of seed.arcShape) tags.add(tag)
  }
  return tags
}

/**
 * Multiplicative arc-affinity boost: ARC_BOOST_PER_TAG per matched tag,
 * capped at ARC_BOOST_CAP (so two matches already saturate it). Tags are
 * deduplicated before counting; persisted arcShape arrays carry each tag at
 * most once, so this is purely defensive.
 */
export function applyArcBoost(
  baseScore: number,
  candidateArcShape: string[],
  preferredTags: Set<string>,
): number {
  let matched = 0
  for (const tag of new Set(candidateArcShape)) {
    if (preferredTags.has(tag)) matched++
  }
  const boost = Math.min(ARC_BOOST_CAP, ARC_BOOST_PER_TAG * matched)
  return baseScore * (1 + boost)
}
