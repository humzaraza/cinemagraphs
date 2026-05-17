import { prisma } from './prisma'
import { invalidateFilmSimilarCache } from './cache'
import { logger } from './logger'

const similarLogger = logger.child({ module: 'similar-films' })

// Final tuned weights after PR 4a validation. Keywords dominate the score
// because TMDB keywords carry the most semantic information (themes, narrative
// devices) and the cappedIntersection metric (see below) makes them legible to
// the scorer in a way that Jaccard did not. Director and era are tiebreakers.
// Genre weight was lowered because TMDB's coarse 3-tuple genres were causing
// genre matches to dominate everything else (Marvel films flooding sci-fi).
export const WEIGHTS = {
  keywords: 0.55,
  genres: 0.15,
  director: 0.15,
  era: 0.15,
} as const

export const DEFAULT_TOP_N = 20

export interface FilmForScoring {
  id: string
  keywords: string[]
  genres: string[]
  director: string | null
  releaseDate: Date | null
}

export interface SimilarityBreakdown {
  keywords: number
  genres: number
  director: number
  era: number
}

export interface SimilarityResult {
  score: number
  signals: SimilarityBreakdown
  /**
   * True when keyword signal was unavailable on either side. The keyword
   * contribution is zeroed and weights are NOT renormalized: the maximum
   * possible degraded score is the sum of the non-keyword weights (0.45).
   */
  keywordsDegraded: boolean
}

export interface ScoredCandidate {
  filmId: string
  score: number
  signals: SimilarityBreakdown
  keywordsDegraded: boolean
}

/**
 * Jaccard similarity on two string arrays. Case sensitive (callers normalize upstream).
 * Returns 0 when either side is empty so empty inputs never spuriously match each other.
 *
 * Used for the genre signal. The keyword signal switched to cappedIntersection
 * because TMDB keyword sets are too sparse for Jaccard's union penalty to make
 * sense.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) intersection++
  }
  const union = setA.size + setB.size - intersection
  if (union === 0) return 0
  return intersection / union
}

/**
 * Capped intersection score: counts shared elements, saturating at `cap`.
 * Returns min(|A ∩ B|, cap) / cap, in [0, 1].
 *
 * Used for keyword similarity instead of Jaccard. Jaccard is too punitive
 * for TMDB-style keyword sets (10-30 elements with specific vocabulary):
 * even genuinely-similar films share at most 3-5 keywords out of unions
 * of 30+, scoring under 0.10. The cap-saturated metric rewards real
 * thematic overlap (3 shared keywords = 0.6) without inflating from
 * sparse data on either side.
 *
 * Future: a later PR may replace this with semantic embeddings for
 * cross-vocabulary matching ("dream" ↔ "subconscious" etc).
 */
export function cappedIntersection(
  a: readonly string[],
  b: readonly string[],
  cap: number = 5,
): number {
  if (cap <= 0) return 0
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  let count = 0
  for (const item of new Set(b)) {
    if (setA.has(item)) {
      count++
      if (count >= cap) return 1.0
    }
  }
  return count / cap
}

/**
 * Binary director match. 1.0 when both films share a director, 0 otherwise.
 * Schema stores a single director per film.
 */
export function directorScore(a: string | null, b: string | null): number {
  if (!a || !b) return 0
  return a === b ? 1 : 0
}

/**
 * Era similarity from the PR 4a spec:
 *   Same decade: 1.0
 *   Adjacent decade: 0.6
 *   Within 30 years: 0.3
 *   Otherwise: 0
 * Decade buckets are used for the top two tiers because they group films by
 * cultural era. The 0.3 tier falls back to literal year distance so the
 * boundary matches the spec's "within 30yr" wording.
 * Missing release date on either side yields 0.
 */
export function eraScore(yearA: number | null, yearB: number | null): number {
  if (yearA === null || yearB === null) return 0
  const decadeA = Math.floor(yearA / 10)
  const decadeB = Math.floor(yearB / 10)
  const decadeDelta = Math.abs(decadeA - decadeB)
  if (decadeDelta === 0) return 1
  if (decadeDelta === 1) return 0.6
  if (Math.abs(yearA - yearB) <= 30) return 0.3
  return 0
}

function getYear(date: Date | null): number | null {
  if (!date) return null
  const y = date.getFullYear()
  return Number.isNaN(y) ? null : y
}

/**
 * Compute weighted similarity between two films.
 *
 * Keyword signal uses cappedIntersection (cap=5), not Jaccard, because TMDB
 * keyword sets are too sparse for Jaccard to register real thematic overlap
 * (see cappedIntersection JSDoc). Genre signal still uses Jaccard.
 *
 * Degraded mode: if EITHER film has no keywords, the keyword contribution is
 * set to 0 and the remaining weights are NOT renormalized. The maximum
 * possible degraded score is therefore the sum of the non-keyword weights
 * (0.45), which is intentional: a candidate with missing data should rank
 * below any well-formed candidate that scores above 0.45.
 */
export function scorePair(source: FilmForScoring, candidate: FilmForScoring): SimilarityResult {
  const keywordsDegraded = source.keywords.length === 0 || candidate.keywords.length === 0
  const signals: SimilarityBreakdown = {
    keywords: keywordsDegraded ? 0 : cappedIntersection(source.keywords, candidate.keywords, 5),
    genres: jaccard(source.genres, candidate.genres),
    director: directorScore(source.director, candidate.director),
    era: eraScore(getYear(source.releaseDate), getYear(candidate.releaseDate)),
  }

  const score =
    WEIGHTS.keywords * signals.keywords +
    WEIGHTS.genres * signals.genres +
    WEIGHTS.director * signals.director +
    WEIGHTS.era * signals.era

  return { score, signals, keywordsDegraded }
}

/**
 * Rank all candidates against a source and return the top N (score > 0, sorted desc).
 * Pure: no DB access. Used by both per-import and backfill paths.
 */
export function computeTopSimilarFor(
  source: FilmForScoring,
  candidates: readonly FilmForScoring[],
  n: number = DEFAULT_TOP_N,
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.id === source.id) continue
    const { score, signals, keywordsDegraded } = scorePair(source, candidate)
    if (score <= 0) continue
    scored.push({ filmId: candidate.id, score, signals, keywordsDegraded })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, n)
}

const SCORING_SELECT = {
  id: true,
  keywords: true,
  genres: true,
  director: true,
  releaseDate: true,
} as const

/**
 * Commit one film's top-N to the SimilarFilm table. Clear-and-rewrite in a
 * single transaction so a reader either sees the old set or the new set,
 * never a mid-write mix. Each call is its own transaction so the bidirectional
 * pass does not hold long-running locks across many films.
 */
async function writeTopForFilm(filmId: string, top: ScoredCandidate[]): Promise<void> {
  await prisma.$transaction([
    prisma.similarFilm.deleteMany({ where: { filmId } }),
    ...(top.length > 0
      ? [
          prisma.similarFilm.createMany({
            data: top.map((t) => ({
              filmId,
              similarFilmId: t.filmId,
              similarityScore: t.score,
              matchSignals: { ...t.signals, keywordsDegraded: t.keywordsDegraded },
            })),
          }),
        ]
      : []),
  ])
}

/**
 * Replace the precomputed SimilarFilm rows for one source film, and then
 * (bidirectional update) recompute each of its top-N neighbors so the new
 * source can also appear in their lists. One level only: neighbors of
 * neighbors are NOT recursed. Periodic full rebuilds remain useful for the
 * long tail of films that are not in any new film's top-N.
 *
 * Idempotent: clear-and-rewrite per film. Safe to call repeatedly.
 *
 * Ordering: the source's own top-N commits FIRST. Each neighbor's recompute
 * then runs sequentially in its own transaction so a single slow or failing
 * neighbor cannot poison the others or block other writers. A failure on one
 * neighbor is logged and swallowed; the source's commit and the remaining
 * neighbors still proceed.
 */
export async function recomputeSimilarFilmsForFilm(
  filmId: string,
  n: number = DEFAULT_TOP_N,
): Promise<number> {
  // Single catalog fetch reused for every recompute in this call. computeTopSimilarFor
  // already skips the source by id, so the same array works as the candidate pool
  // for the source AND for each of its neighbors.
  const catalog = await prisma.film.findMany({ select: SCORING_SELECT })
  const source = catalog.find((f) => f.id === filmId)
  if (!source) return 0

  const sourceTop = computeTopSimilarFor(source, catalog, n)
  await writeTopForFilm(filmId, sourceTop)

  // Bidirectional pass: each Xi gets its own top-N recomputed and committed
  // independently so the source's neighbors are kept in sync with the new film
  // entering their candidate pool. Sequential, not parallel: total work is small
  // (~20 × catalog-traversal in JS) and serial keeps DB pressure predictable.
  for (const candidate of sourceTop) {
    try {
      const neighbor = catalog.find((f) => f.id === candidate.filmId)
      if (!neighbor) continue
      const neighborTop = computeTopSimilarFor(neighbor, catalog, n)
      await writeTopForFilm(neighbor.id, neighborTop)
      await invalidateFilmSimilarCache(neighbor.id)
    } catch (err) {
      similarLogger.warn(
        { err, sourceId: filmId, neighborId: candidate.filmId },
        'bidirectional recompute failed for neighbor; continuing',
      )
    }
  }

  return sourceTop.length
}
