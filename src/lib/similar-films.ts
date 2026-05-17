import { prisma } from './prisma'

// Weights from the PR 4a spec. Keywords carry the most semantic information
// (themes, narrative devices). Director and era are tiebreakers.
export const WEIGHTS = {
  keywords: 0.45,
  genres: 0.25,
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
  /** True when keyword signal was unavailable on either side and weights were renormalized. */
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
 * Degraded mode: if EITHER film has no keywords, drop the keyword weight and
 * renormalize the remaining three so they sum to 1.0. Spec: "Algorithm never
 * returns an empty list because of missing data."
 */
export function scorePair(source: FilmForScoring, candidate: FilmForScoring): SimilarityResult {
  const signals: SimilarityBreakdown = {
    keywords: jaccard(source.keywords, candidate.keywords),
    genres: jaccard(source.genres, candidate.genres),
    director: directorScore(source.director, candidate.director),
    era: eraScore(getYear(source.releaseDate), getYear(candidate.releaseDate)),
  }

  const keywordsDegraded = source.keywords.length === 0 || candidate.keywords.length === 0

  let score: number
  if (keywordsDegraded) {
    const remaining = WEIGHTS.genres + WEIGHTS.director + WEIGHTS.era
    score =
      (WEIGHTS.genres * signals.genres +
        WEIGHTS.director * signals.director +
        WEIGHTS.era * signals.era) /
      remaining
  } else {
    score =
      WEIGHTS.keywords * signals.keywords +
      WEIGHTS.genres * signals.genres +
      WEIGHTS.director * signals.director +
      WEIGHTS.era * signals.era
  }

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
 * Replace the precomputed SimilarFilm rows for one source film.
 * Used by the per-import hook in importMovie(). Idempotent: clear-and-rewrite.
 */
export async function recomputeSimilarFilmsForFilm(
  filmId: string,
  n: number = DEFAULT_TOP_N,
): Promise<number> {
  const source = await prisma.film.findUnique({
    where: { id: filmId },
    select: SCORING_SELECT,
  })
  if (!source) return 0

  const candidates = await prisma.film.findMany({
    where: { id: { not: filmId } },
    select: SCORING_SELECT,
  })

  const top = computeTopSimilarFor(source, candidates, n)

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

  return top.length
}
