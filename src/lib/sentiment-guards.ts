import type { Film } from '@/generated/prisma/client'

// ── Sentiment-graph data-integrity guards ───────────────────────────────────
//
// Dependency-free on purpose: this module is imported by the generator
// (claude.ts, hybrid-sentiment.ts), by the write path (sentiment-beat-lock.ts),
// and by scripts, so it must not pull in the Anthropic SDK, Prisma, or env.
//
// Every guard THROWS. A graph that fails one is rejected before it can reach a
// write; nothing here rounds, clamps, or downgrades to a warning.

/** Maximum distance allowed between the mean of the beat scores and the
 *  headline score (overallSentiment on the model output, overallScore on the
 *  row). Mirrors the ±0.2 the prompts already demand. */
export const MEAN_SCORE_TOLERANCE = 0.2

// Absorbs binary floating-point noise on the boundary only: 7.2 - 7 evaluates
// to 0.20000000000000018 in IEEE-754, and a gap that is exactly 0.2 in decimal
// must pass. Any gap a human would read as larger than 0.2 still fails.
const FLOAT_EPSILON = 1e-9

/** Arithmetic mean of `score` across the beats. Throws if any score is not a
 *  finite number, so a NaN can never silently satisfy a later comparison. */
export function meanBeatScore(dataPoints: ReadonlyArray<{ score: unknown }>): number {
  if (dataPoints.length === 0) {
    throw new Error('meanBeatScore: no data points')
  }
  let sum = 0
  for (let i = 0; i < dataPoints.length; i++) {
    const score = dataPoints[i].score
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new Error(`dataPoints[${i}].score is not a finite number`)
    }
    sum += score
  }
  return sum / dataPoints.length
}

/** The film's headline score: the mean of its beat scores, rounded to one
 *  decimal. This is the ONLY source of overallScore. It is computed in code
 *  from the beats actually being written, never emitted by the model and
 *  never taken from an external rating. */
export function overallScoreFromBeats(dataPoints: ReadonlyArray<{ score: unknown }>): number {
  return Math.round(meanBeatScore(dataPoints) * 10) / 10
}

/** Reject a set of beats whose mean sits more than MEAN_SCORE_TOLERANCE from
 *  the headline score they are written alongside. With overallScore derived
 *  by overallScoreFromBeats the gap is at most 0.05 from rounding, so this is
 *  a backstop against a caller that bypasses the derivation. */
export function assertMeanWithinTolerance(
  dataPoints: ReadonlyArray<{ score: unknown }>,
  overallSentiment: number
): void {
  if (typeof overallSentiment !== 'number' || !Number.isFinite(overallSentiment)) {
    throw new Error('overallSentiment is not a finite number')
  }
  const mean = meanBeatScore(dataPoints)
  const gap = Math.abs(mean - overallSentiment)
  // Written as "reject unless provably inside" rather than `gap > tolerance`
  // so an unexpected NaN fails instead of passing.
  if (!(gap <= MEAN_SCORE_TOLERANCE + FLOAT_EPSILON)) {
    throw new Error(
      `Beat mean ${mean.toFixed(3)} is ${gap.toFixed(3)} from overallSentiment ${overallSentiment} (tolerance ${MEAN_SCORE_TOLERANCE})`
    )
  }
}

/** Return the film's release date, or throw. A graph is built from reviews
 *  of the film, and a film with no release date or a future one has none:
 *  whatever a search turns up belongs to other films with similar titles.
 *  Both cases are refused; there is no "generate anyway". */
export function requireReleasedFilm(
  film: Pick<Film, 'id' | 'title' | 'releaseDate'>,
  now: Date = new Date()
): Date {
  const { releaseDate } = film
  if (!(releaseDate instanceof Date) || Number.isNaN(releaseDate.getTime())) {
    throw new Error(`Film "${film.title}" (${film.id}) has no release date; no graph can be built`)
  }
  if (releaseDate > now) {
    throw new Error(
      `Film "${film.title}" (${film.id}) is not released until ${releaseDate.toISOString().slice(0, 10)}; no graph can be built`
    )
  }
  return releaseDate
}

/** Return the film's runtime in minutes, or throw. Runtime is stored as 0 (not
 *  null) for many rows, so a null check is not enough: the test is `> 0`.
 *  There is deliberately no default; a graph spanning an invented runtime is
 *  wrong data, not a degraded result. */
export function requireFilmRuntime(film: Pick<Film, 'id' | 'title' | 'runtime'>): number {
  const { runtime } = film
  if (typeof runtime !== 'number' || !(runtime > 0)) {
    throw new Error(
      `Film "${film.title}" (${film.id}) has no usable runtime (stored ${runtime === null ? 'null' : String(runtime)})`
    )
  }
  return runtime
}
