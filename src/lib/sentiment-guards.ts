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

// ── No source review text in displayed summaries ────────────────────────────
//
// Everything the model writes about a film (each beat's reviewEvidence, the
// arc summary, the biggest-swing line) is shown to users. Source reviews are
// never displayed, and that promise has to hold for the summaries too: a
// summary may say what reviewers thought, in its own words, but may not
// carry a run of their words.
//
// The test is a shared run of VERBATIM_RUN_WORDS consecutive words between a
// generated text and any source review, compared case-insensitively with
// punctuation ignored. Eight is the threshold: shorter runs collide by chance
// on ordinary English ("in the second half of the film" is seven words),
// while eight or more in the same order is, outside a film's own title,
// almost always lifted. The film title is excluded from matching because
// both the reviews and an honest summary will name the film.

export const VERBATIM_RUN_WORDS = 8

// Marks a position that must never match (where the film title was).
const RUN_BREAK = '\u0000'

function tokenizeForOverlap(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length > 0)
}

/** Index every run of `n` consecutive words across the source reviews. */
export function buildReviewRunIndex(
  reviewTexts: ReadonlyArray<string>,
  n: number = VERBATIM_RUN_WORDS
): Set<string> {
  const index = new Set<string>()
  for (const text of reviewTexts) {
    const tokens = tokenizeForOverlap(text)
    for (let i = 0; i + n <= tokens.length; i++) {
      index.add(tokens.slice(i, i + n).join(' '))
    }
  }
  return index
}

/** Return the first run of `n` consecutive words that `text` shares with the
 *  indexed reviews, or null. Occurrences of `ignorePhrase` (the film title)
 *  in `text` break a run instead of counting toward one. */
export function findVerbatimRun(
  text: string,
  index: ReadonlySet<string>,
  options: { n?: number; ignorePhrase?: string } = {}
): string | null {
  const n = options.n ?? VERBATIM_RUN_WORDS
  const tokens = tokenizeForOverlap(text)
  const ignore = options.ignorePhrase ? tokenizeForOverlap(options.ignorePhrase) : []
  if (ignore.length > 0) {
    for (let i = 0; i + ignore.length <= tokens.length; i++) {
      if (ignore.every((w, j) => tokens[i + j] === w)) {
        for (let j = 0; j < ignore.length; j++) tokens[i + j] = RUN_BREAK
      }
    }
  }
  for (let i = 0; i + n <= tokens.length; i++) {
    const window = tokens.slice(i, i + n)
    if (window.includes(RUN_BREAK)) continue
    const run = window.join(' ')
    if (index.has(run)) return run
  }
  return null
}

export interface DisplayedGraphText {
  dataPoints: ReadonlyArray<{ label?: unknown; reviewEvidence?: unknown }>
  summary?: unknown
  biggestSentimentSwing?: unknown
}

/** Every piece of model-written text on a graph that reaches a screen. */
export function displayedGraphTexts(graph: DisplayedGraphText): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = []
  graph.dataPoints.forEach((dp, i) => {
    if (typeof dp.reviewEvidence === 'string' && dp.reviewEvidence.length > 0) {
      const label = typeof dp.label === 'string' ? dp.label : `#${i}`
      out.push({ where: `dataPoints[${i}].reviewEvidence ("${label}")`, text: dp.reviewEvidence })
    }
  })
  if (typeof graph.summary === 'string' && graph.summary.length > 0) {
    out.push({ where: 'summary', text: graph.summary })
  }
  if (typeof graph.biggestSentimentSwing === 'string' && graph.biggestSentimentSwing.length > 0) {
    out.push({ where: 'biggestSentimentSwing', text: graph.biggestSentimentSwing })
  }
  return out
}

export interface VerbatimViolation {
  where: string
  text: string
  /** The shared run of words, normalised (lowercase, no punctuation). */
  run: string
}

/** Every displayed text on the graph that shares a run of VERBATIM_RUN_WORDS
 *  consecutive words with a source review. Empty when the graph is clean. */
export function findVerbatimViolations(
  graph: DisplayedGraphText,
  reviewTexts: ReadonlyArray<string>,
  options: { filmTitle?: string } = {}
): VerbatimViolation[] {
  const index = buildReviewRunIndex(reviewTexts)
  if (index.size === 0) return []
  const out: VerbatimViolation[] = []
  for (const { where, text } of displayedGraphTexts(graph)) {
    const run = findVerbatimRun(text, index, { ignorePhrase: options.filmTitle })
    if (run) out.push({ where, text, run })
  }
  return out
}

export function verbatimErrorMessage(v: VerbatimViolation): string {
  return `Verbatim review text in ${v.where}: shares ${VERBATIM_RUN_WORDS} consecutive words with a source review ("${v.run}")`
}

/** Reject a graph whose displayed text shares a run of VERBATIM_RUN_WORDS
 *  consecutive words with any source review. Throws; nothing is repaired.
 *  Generation paths call ensureNoVerbatimReviewText (claude.ts) instead,
 *  which gives the model one chance to reword before this verdict is final. */
export function assertNoVerbatimReviewText(
  graph: DisplayedGraphText,
  reviewTexts: ReadonlyArray<string>,
  options: { filmTitle?: string } = {}
): void {
  const violations = findVerbatimViolations(graph, reviewTexts, options)
  if (violations.length > 0) throw new Error(verbatimErrorMessage(violations[0]))
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
