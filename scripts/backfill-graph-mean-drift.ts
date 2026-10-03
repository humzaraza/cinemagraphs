/**
 * NOTE (2026-10): overallScore is now derived from the beats on every write
 * path, and scripts/recompute-overall-from-beats.ts repairs existing rows at
 * zero model cost. Regeneration is no longer needed to fix headline drift;
 * this script remains as a general tiered regeneration tool.
 *
 * Step 4 backfill: regenerate every SentimentGraph whose beat-score mean sits
 * more than MEAN_SCORE_TOLERANCE (0.2) from its stored overallScore.
 *
 * Selection runs in SQL with the same expression as
 * scripts/sql/graph-mean-distribution.sql, largest gap first.
 *
 * Tiers (run over-one first, then rest):
 *   --tier over-one   gap > 1.0
 *   --tier rest       0.2 < gap <= 1.0
 *   --tier all        gap > 0.2, largest gap first
 *
 * Batching: films go to Anthropic's Message Batches API in chunks
 * (--chunk-size, default 100; half the synchronous price). After each chunk
 * every result is validated by the SAME guards the app uses
 * (validateGraph -> assertMeanWithinTolerance, requireFilmRuntime) and
 * written. Then the cumulative failure rate for this run is checked:
 * failed / attempted > --max-failure-rate (default 0.05) stops the run before
 * the next chunk is submitted and prints a report. Skips (pre-release, too
 * few reviews, no runtime) are recorded but are not attempts.
 *
 * Every failure is appended to backfill-graph-mean-drift-run.jsonl (one JSON
 * object per line, gitignored) and to .graph-mean-backfill-checkpoint.json.
 *
 * Retry: a film whose response failed validation is pending again on the
 * next run, up to MAX_ATTEMPTS in total. Its prompt then carries a corrective
 * note with the previous mean and headline score. At temperature 0 the same
 * prompt would otherwise reproduce the same rejected output.
 *
 * Write path: safeWriteSentimentGraph (beat-lock preserving) by default. That
 * merge keeps the OLD score on any existing beat whose label the new output
 * does not reproduce. The write path itself now refuses (throws, nothing
 * persisted) when the merged row would sit outside tolerance of the new
 * headline; the script records that as merge_out_of_tolerance. It is a
 * terminal failure: the same labels will mismatch again on retry.
 *
 *   --force-orphan        write the validated output verbatim for every film.
 *                         Orphans user beat ratings whose labels changed, so it
 *                         asks for interactive confirmation (--yes to skip).
 *   --force-when-unrated  per film: verbatim overwrite when NO user review on
 *                         that film carries beat ratings (nothing to orphan),
 *                         otherwise the safe merge. Needs no confirmation.
 *
 * Failure-rate basis:
 *   --failure-rate-basis all       every failure counts (default, the stated spec)
 *   --failure-rate-basis terminal  only failures that a retry cannot fix count:
 *                                  batch errors, write errors, merge drift, and
 *                                  any failure on the final attempt. A model
 *                                  output rejected on its first attempt is left
 *                                  for the retry pass instead of tripping the stop.
 *
 * Usage:
 *   npx tsx scripts/backfill-graph-mean-drift.ts --tier over-one --dry-run --skip-plot-fetch
 *   npx tsx scripts/backfill-graph-mean-drift.ts --tier over-one --commit --expect-host plain-shadow
 *   npx tsx scripts/backfill-graph-mean-drift.ts --tier rest --commit --expect-host plain-shadow
 *   ... --limit N | --film-ids a,b,c | --chunk-size 50 | --max-failure-rate 0.05
 *   ... --force-orphan [--yes] | --force-when-unrated | --failure-rate-basis terminal
 *   --skip-plot-fetch (dry-run only) sizes every prompt as hybrid with a full-length
 *   plot placeholder instead of fetching Wikipedia, so the estimate is fast.
 *
 * GATED: mutates whichever Neon branch DATABASE_URL points at. The script
 * prints the host (credentials stripped) before doing anything, and
 * --expect-host <substring> aborts when the host does not contain it. Do not
 * run --commit without explicit go-ahead.
 */
import './_load-env'
import './_neon-ws'

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import Anthropic from '@anthropic-ai/sdk'
import type { Film } from '../src/generated/prisma/client'
import { prisma } from '../src/lib/prisma'
import {
  SENTIMENT_MODEL,
  SENTIMENT_MAX_TOKENS,
  buildAnalysisPromptParts,
  ensureNoVerbatimReviewText,
} from '../src/lib/claude'
import {
  MEAN_SCORE_TOLERANCE,
  assertMeanWithinTolerance,
  meanBeatScore,
  requireFilmRuntime,
  requireReleasedFilm,
} from '../src/lib/sentiment-guards'
import {
  MIN_QUALITY_REVIEWS,
  buildHybridPrompt,
  computeHybridBeatCount,
  validateGraph,
  type ParsedGraph,
} from '../src/lib/hybrid-sentiment'
import { isQualityReview } from '../src/lib/sentiment-pipeline'
import { computeReviewHash } from '../src/lib/review-fetcher'
import { fetchWikipediaPlot } from '../src/lib/sources/wikipedia'
import {
  safeWriteSentimentGraph,
  forceOverwriteSentimentGraph,
  SentimentGraphMeanDriftError,
} from '../src/lib/sentiment-beat-lock'
import { invalidateFilmCache } from '../src/lib/cache'

const CALLER_PATH = 'script-backfill-graph-mean' as const
const CHECKPOINT_PATH = path.resolve('.graph-mean-backfill-checkpoint.json')
const CHECKPOINT_TMP = `${CHECKPOINT_PATH}.tmp`
const FAILURE_LOG = path.resolve('backfill-graph-mean-drift-run.jsonl')
const POLL_INTERVAL_MS = 30_000
const MAX_ATTEMPTS = 2
const MAX_BATCH_SIZE = 10_000
const OVER_ONE_GAP = 1.0
const BEAT_COUNT_MIN = 8
const BEAT_COUNT_MAX = 22
// Per-request output estimate for the dry-run cost line only. Measured: the
// June 2026 production batch of 2,828 films averaged 2,172 output tokens.
const ESTIMATED_OUTPUT_TOKENS = 2_200
const BATCH_PRICE_PER_MTOK_INPUT = 1.5
const BATCH_PRICE_PER_MTOK_OUTPUT = 7.5
// Matches HYBRID_PLOT_CHAR_CAP in hybrid-sentiment.ts (not exported). Used
// only to size a placeholder plot under --skip-plot-fetch.
const PLOT_PLACEHOLDER_CHARS = 6_000

// Failures a second attempt with a corrective note can plausibly fix. Anything
// else (batch transport, write errors, label mismatch in the merge) is
// terminal for the purposes of --failure-rate-basis terminal.
const RETRYABLE_CATEGORIES = new Set<string>(['mean_out_of_tolerance', 'validation', 'json_parse', 'beat_count'])

// ── Types ────────────────────────────────────────────────────────────────────

type Tier = 'over-one' | 'rest' | 'all'

type SkipStatus = 'skipped_prerelease' | 'skipped_no_reviews' | 'skipped_no_runtime'
type EntryStatus = 'success' | 'failed' | SkipStatus

type FailureCategory =
  | 'mean_out_of_tolerance'
  | 'validation'
  | 'json_parse'
  | 'beat_count'
  | 'batch_errored'
  | 'batch_canceled'
  | 'batch_expired'
  | 'merge_out_of_tolerance'
  | 'write_error'

interface CheckpointEntry {
  status: EntryStatus
  tier: Tier
  attempts: number
  timestamp: string
  gapBefore: number
  category?: FailureCategory
  error?: string
  lastMean?: number
  lastOverall?: number
  lastGap?: number
  beatCount?: number
  writeStatus?: string
  gapAfter?: number
  inputTokens?: number
  outputTokens?: number
}

interface CheckpointBatch {
  id: string
  submittedAt: string
  filmIds: string[]
  tier: Tier
}

interface Checkpoint {
  version: 1
  startedAt: string
  films: Record<string, CheckpointEntry>
  batch?: CheckpointBatch
}

interface DriftRow {
  filmId: string
  title: string
  overallScore: number
  meanScore: number
  gap: number
}

interface Args {
  tier: Tier
  dryRun: boolean
  commit: boolean
  limit: number | null
  filmIds: Set<string> | null
  chunkSize: number
  maxFailureRate: number
  failureRateBasis: 'all' | 'terminal'
  forceOrphan: boolean
  forceWhenUnrated: boolean
  skipPlotFetch: boolean
  yes: boolean
  expectHost: string | null
}

interface RunTally {
  attempted: number
  succeeded: number
  failed: number
  failedTerminal: number
  skipped: number
  inputTokens: number
  outputTokens: number
  byCategory: Record<string, number>
  byWriteMode: Record<string, number>
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = {
    tier: 'all',
    dryRun: false,
    commit: false,
    limit: null,
    filmIds: null,
    chunkSize: 100,
    maxFailureRate: 0.05,
    failureRateBasis: 'all',
    forceOrphan: false,
    forceWhenUnrated: false,
    skipPlotFetch: false,
    yes: false,
    expectHost: null,
  }
  let tierGiven = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--commit') args.commit = true
    else if (a === '--force-orphan') args.forceOrphan = true
    else if (a === '--force-when-unrated') args.forceWhenUnrated = true
    else if (a === '--skip-plot-fetch') args.skipPlotFetch = true
    else if (a === '--yes') args.yes = true
    else if (a === '--failure-rate-basis') {
      const b = argv[++i]
      if (b !== 'all' && b !== 'terminal') throw new Error(`--failure-rate-basis must be all or terminal (got: ${b})`)
      args.failureRateBasis = b
    } else if (a === '--tier') {
      const t = argv[++i]
      if (t !== 'over-one' && t !== 'rest' && t !== 'all') {
        throw new Error(`--tier must be over-one, rest, or all (got: ${t})`)
      }
      args.tier = t
      tierGiven = true
    } else if (a === '--limit') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1) throw new Error(`--limit requires a positive integer, got: ${argv[i]}`)
      args.limit = n
    } else if (a === '--chunk-size') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) {
        throw new Error(`--chunk-size must be 1..${MAX_BATCH_SIZE}, got: ${argv[i]}`)
      }
      args.chunkSize = n
    } else if (a === '--max-failure-rate') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`--max-failure-rate must be 0..1, got: ${argv[i]}`)
      args.maxFailureRate = n
    } else if (a === '--film-ids') {
      const raw = argv[++i]
      if (!raw) throw new Error('--film-ids requires a comma-separated list of film ids')
      const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      if (ids.length === 0) throw new Error('--film-ids parsed to an empty list')
      args.filmIds = new Set(ids)
    } else if (a === '--expect-host') {
      args.expectHost = argv[++i] ?? null
      if (!args.expectHost) throw new Error('--expect-host requires a substring')
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }
  if (!tierGiven) throw new Error('--tier is required: over-one (run first), rest, or all')
  if (!args.dryRun && !args.commit) throw new Error('Must pass --dry-run or --commit')
  if (args.dryRun && args.commit) throw new Error('Cannot pass both --dry-run and --commit')
  if (args.skipPlotFetch && !args.dryRun) throw new Error('--skip-plot-fetch is only valid with --dry-run')
  if (args.forceOrphan && args.forceWhenUnrated) throw new Error('Pass --force-orphan or --force-when-unrated, not both')
  return args
}

// ── Safety: which database ───────────────────────────────────────────────────

function databaseHost(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  try {
    return new URL(url).host
  } catch {
    // Never print the raw URL: it carries credentials.
    return '<unparseable DATABASE_URL>'
  }
}

async function confirmForceOrphan(args: Args): Promise<void> {
  if (!args.forceOrphan) return
  console.log(
    [
      '',
      '================================================================',
      'WARNING: --force-orphan enabled. Any user beat ratings whose',
      'labels do not match the new graph will be orphaned.',
      '================================================================',
      '',
    ].join('\n')
  )
  if (args.yes) {
    console.log('[--yes supplied, skipping interactive confirmation]')
    return
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question("Type 'yes' to continue or anything else to abort: ")
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Aborted.')
      process.exit(1)
    }
  } finally {
    rl.close()
  }
}

// ── Checkpoint + failure log ─────────────────────────────────────────────────

function emptyCheckpoint(): Checkpoint {
  return { version: 1, startedAt: new Date().toISOString(), films: {} }
}

function loadCheckpoint(): Checkpoint {
  if (!fs.existsSync(CHECKPOINT_PATH)) return emptyCheckpoint()
  try {
    const parsed = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8')) as Checkpoint
    if (parsed.version !== 1 || !parsed.films || typeof parsed.films !== 'object') {
      console.warn('[checkpoint] unrecognised shape, starting fresh')
      return emptyCheckpoint()
    }
    return parsed
  } catch (err) {
    console.warn(`[checkpoint] unreadable (${err instanceof Error ? err.message : err}), starting fresh`)
    return emptyCheckpoint()
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  fs.writeFileSync(CHECKPOINT_TMP, JSON.stringify(cp, null, 2))
  fs.renameSync(CHECKPOINT_TMP, CHECKPOINT_PATH)
}

function logFailure(event: Record<string, unknown>): void {
  fs.appendFileSync(FAILURE_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`)
}

function isPending(entry: CheckpointEntry | undefined): boolean {
  if (!entry) return true
  if (entry.status === 'failed') return entry.attempts < MAX_ATTEMPTS
  return false
}

// ── Selection ────────────────────────────────────────────────────────────────

async function selectDriftingGraphs(tier: Tier): Promise<DriftRow[]> {
  // Same expression as scripts/sql/graph-mean-distribution.sql. Tolerance is
  // the app constant so the selection and the guard can never disagree.
  const rows = await prisma.$queryRaw<DriftRow[]>`
    WITH scored AS (
      SELECT
        sg."filmId",
        sg."overallScore",
        (
          SELECT avg((p->>'score')::double precision)
          FROM jsonb_array_elements(sg."dataPoints") AS p
        ) AS mean_score
      FROM "SentimentGraph" sg
    )
    SELECT
      s."filmId"                              AS "filmId",
      f.title                                 AS title,
      s."overallScore"                        AS "overallScore",
      s.mean_score                            AS "meanScore",
      abs(s.mean_score - s."overallScore")    AS gap
    FROM scored s
    JOIN "Film" f ON f.id = s."filmId"
    WHERE s.mean_score IS NOT NULL
      AND abs(s.mean_score - s."overallScore") > ${MEAN_SCORE_TOLERANCE}
    ORDER BY gap DESC, f.title ASC
  `
  if (tier === 'over-one') return rows.filter((r) => r.gap > OVER_ONE_GAP)
  if (tier === 'rest') return rows.filter((r) => r.gap <= OVER_ONE_GAP)
  return rows
}

// ── Per-film request build ───────────────────────────────────────────────────

type BuildOutcome =
  | { kind: 'skipped'; status: SkipStatus; reason: string }
  | {
      kind: 'built'
      generationMode: 'hybrid' | 'review_only_fallback'
      request: Anthropic.Messages.Batches.BatchCreateParams.Request
      promptChars: number
    }

function correctiveNote(prior: CheckpointEntry | undefined): string {
  if (!prior || prior.status !== 'failed') return ''
  if (prior.lastMean !== undefined && prior.lastOverall !== undefined && prior.lastGap !== undefined) {
    return (
      `IMPORTANT: A previous attempt at this graph was rejected. The arithmetic mean of its dataPoints scores was ${prior.lastMean.toFixed(2)}, ` +
      `which is ${prior.lastGap.toFixed(2)} away from the overallSentiment it reported (${prior.lastOverall}). ` +
      `The mean of ALL dataPoints scores MUST be within ±${MEAN_SCORE_TOLERANCE} of overallSentiment. ` +
      `Add up your beat scores, divide by the number of beats, and adjust individual scores until that mean lands inside the window before you answer.\n\n`
    )
  }
  return (
    `IMPORTANT: A previous attempt at this graph was rejected (${prior.error ?? 'validation failed'}). ` +
    `Respond with ONLY valid JSON matching the schema, with both label and labelFull on every beat, ` +
    `and with the mean of ALL dataPoints scores within ±${MEAN_SCORE_TOLERANCE} of overallSentiment.\n\n`
  )
}

async function buildRequestForFilm(
  film: Film,
  prior: CheckpointEntry | undefined,
  opts: { skipPlotFetch: boolean }
): Promise<BuildOutcome> {
  // No release date or a future one: no graph. Same guard as the app.
  try {
    requireReleasedFilm(film)
  } catch (err) {
    return {
      kind: 'skipped',
      status: 'skipped_prerelease',
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  // Same guard as the app. Runtime 0 (how missing values are stored) and
  // null both land here; there is no 120 fallback.
  let runtime: number
  try {
    runtime = requireFilmRuntime(film)
  } catch (err) {
    return { kind: 'skipped', status: 'skipped_no_runtime', reason: err instanceof Error ? err.message : String(err) }
  }

  const storedReviews = await prisma.review.findMany({
    where: { filmId: film.id },
    orderBy: { fetchedAt: 'desc' },
  })
  const qualityReviews = storedReviews.filter((r) => isQualityReview(r.reviewText))
  if (qualityReviews.length < MIN_QUALITY_REVIEWS) {
    return {
      kind: 'skipped',
      status: 'skipped_no_reviews',
      reason: `Not enough quality reviews: ${qualityReviews.length} < ${MIN_QUALITY_REVIEWS}`,
    }
  }

  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : 'Unknown'
  const plotText = opts.skipPlotFetch
    ? 'x'.repeat(PLOT_PLACEHOLDER_CHARS)
    : typeof year === 'number'
      ? await fetchWikipediaPlot(film.title, year)
      : null
  const note = correctiveNote(prior)

  if (plotText) {
    const beatCount = computeHybridBeatCount(runtime)
    const user =
      note +
      buildHybridPrompt({
        film,
        year,
        runtime,
        plotText,
        reviews: qualityReviews,
        beatCount,
      })
    return {
      kind: 'built',
      generationMode: 'hybrid',
      promptChars: user.length,
      request: {
        custom_id: film.id,
        params: {
          model: SENTIMENT_MODEL,
          max_tokens: SENTIMENT_MAX_TOKENS,
          temperature: 0,
          messages: [{ role: 'user', content: user }],
        },
      },
    }
  }

  const parts = buildAnalysisPromptParts(film, qualityReviews, undefined)
  const user = note + parts.user
  return {
    kind: 'built',
    generationMode: 'review_only_fallback',
    promptChars: parts.system.length + user.length,
    request: {
      custom_id: film.id,
      params: {
        model: SENTIMENT_MODEL,
        max_tokens: SENTIMENT_MAX_TOKENS,
        temperature: 0,
        system: [{ type: 'text', text: parts.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      },
    },
  }
}

// ── Validate + write ─────────────────────────────────────────────────────────

class CategorizedError extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
    readonly meanInfo?: { mean: number; overall: number; gap: number }
  ) {
    super(message)
  }
}

function parseAndValidate(responseText: string): ParsedGraph {
  const cleaned = responseText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    throw new CategorizedError('json_parse', `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    return validateGraph(parsed)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/^Beat mean /.test(message)) {
      throw new CategorizedError('mean_out_of_tolerance', message, meanInfoFrom(parsed))
    }
    throw new CategorizedError('validation', message)
  }
}

// Recomputed from the parsed object, not scraped from the error text, so the
// corrective note on retry carries exact numbers.
function meanInfoFrom(parsed: unknown): { mean: number; overall: number; gap: number } | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.dataPoints) || typeof obj.overallSentiment !== 'number') return undefined
  try {
    const mean = meanBeatScore(obj.dataPoints as Array<{ score: unknown }>)
    return { mean, overall: obj.overallSentiment, gap: Math.abs(mean - obj.overallSentiment) }
  } catch {
    return undefined
  }
}

function buildAnchoredFromString(film: {
  imdbRating: number | null
  rtCriticsScore: number | null
  metacriticScore: number | null
}): string {
  const parts: string[] = []
  if (film.imdbRating) parts.push(`IMDb ${film.imdbRating}`)
  if (film.rtCriticsScore) parts.push(`RT ${film.rtCriticsScore}%`)
  if (film.metacriticScore) parts.push(`MC ${film.metacriticScore}`)
  return parts.join(' | ') || 'No anchor scores available'
}

// Under --force-when-unrated the only thing the lock protects is user beat
// ratings keyed by label. A film with none has nothing to orphan, so a
// verbatim overwrite is free there. Empty JSON objects do not count as rated.
async function resolveWriteMode(
  filmId: string,
  base: 'safe' | 'force',
  forceWhenUnrated: boolean
): Promise<'safe' | 'force'> {
  if (base === 'force' || !forceWhenUnrated) return base
  const rows = await prisma.$queryRaw<Array<{ rated: bigint }>>`
    SELECT count(*)::bigint AS rated
    FROM "UserReview"
    WHERE "filmId" = ${filmId}
      AND "beatRatings" IS NOT NULL
      AND jsonb_typeof("beatRatings") = 'object'
      AND "beatRatings" <> '{}'::jsonb
  `
  return Number(rows[0]?.rated ?? 0) === 0 ? 'force' : 'safe'
}

async function applyResult(
  filmId: string,
  generated: ParsedGraph,
  mode: 'safe' | 'force'
): Promise<{ beatCount: number; writeStatus: string; gapAfter: number }> {
  if (generated.dataPoints.length < BEAT_COUNT_MIN || generated.dataPoints.length > BEAT_COUNT_MAX) {
    throw new CategorizedError(
      'beat_count',
      `Beat count out of expected bounds: got ${generated.dataPoints.length}, expected ${BEAT_COUNT_MIN}-${BEAT_COUNT_MAX}`
    )
  }

  const film = await prisma.film.findUnique({
    where: { id: filmId },
    select: { id: true, title: true, imdbRating: true, rtCriticsScore: true, metacriticScore: true },
  })
  if (!film) throw new CategorizedError('write_error', `Film vanished between submit and apply: ${filmId}`)

  const existing = await prisma.sentimentGraph.findUnique({
    where: { filmId },
    select: { overallScore: true, version: true },
  })

  const reviews = await prisma.review.findMany({
    where: { filmId },
    select: { sourcePlatform: true, reviewText: true, contentHash: true },
  })
  // Same guard as the app: no run of a reviewer's words in displayed text.
  // One rewording request if it does; rejected if that does not clear it.
  let graph: ParsedGraph
  try {
    graph = await ensureNoVerbatimReviewText(
      generated,
      reviews.map((r) => r.reviewText),
      { filmTitle: film.title, filmId }
    )
  } catch (err) {
    throw new CategorizedError('validation', err instanceof Error ? err.message : String(err))
  }
  const qualityReviews = reviews.filter((r) => isQualityReview(r.reviewText))
  const sourcesUsed = [...new Set(qualityReviews.map((r) => r.sourcePlatform.toLowerCase()))]

  const otherFields = {
    overallScore: graph.overallSentiment,
    previousScore: existing?.overallScore ?? null,
    anchoredFrom: buildAnchoredFromString(film),
    peakMoment: graph.peakMoment,
    lowestMoment: graph.lowestMoment,
    biggestSwing: graph.biggestSentimentSwing,
    summary: graph.summary,
    reviewCount: qualityReviews.length,
    sourcesUsed,
    varianceSource: 'external_only',
    generatedAt: new Date(),
    version: (existing?.version ?? 0) + 1,
    // Stored so the cron's hash-skip sees this regeneration as current and
    // does not immediately queue the film again.
    reviewHash: computeReviewHash(qualityReviews),
  }

  let writeStatus: string
  try {
    if (mode === 'force') {
      await forceOverwriteSentimentGraph({
        filmId,
        dataPoints: graph.dataPoints,
        otherFields,
        callerPath: CALLER_PATH,
      })
      writeStatus = 'force_overwritten'
    } else {
      const result = await safeWriteSentimentGraph({
        filmId,
        incomingDataPoints: graph.dataPoints,
        otherFields,
        callerPath: CALLER_PATH,
      })
      writeStatus = result.status
    }
    await prisma.film.update({ where: { id: filmId }, data: { lastReviewCount: qualityReviews.length } })
  } catch (err) {
    if (err instanceof SentimentGraphMeanDriftError) {
      // The write path refused inside its transaction: nothing was persisted.
      // In safe mode this means the regenerated labels did not match the
      // stored ones and the preserved old scores drag the row off the new
      // headline. A retry reproduces the mismatch, so it is terminal.
      throw new CategorizedError(
        'merge_out_of_tolerance',
        `${err.message} [dropped=${err.droppedIncomingLabels.length} preserved=${err.preservedExistingLabels.length}]`,
        { mean: err.mean, overall: err.overallScore, gap: err.gap }
      )
    }
    throw new CategorizedError('write_error', err instanceof Error ? err.message : String(err))
  }

  try {
    await invalidateFilmCache(filmId)
  } catch (err) {
    console.warn(`  [cache] invalidate failed for ${filmId}: ${err instanceof Error ? err.message : err}`)
  }

  // Post-write verification against the row as stored. The write path already
  // refuses a drifting row; this re-read is the independent confirmation that
  // it did, straight from the database.
  const stored = await prisma.sentimentGraph.findUnique({
    where: { filmId },
    select: { dataPoints: true, overallScore: true },
  })
  if (!stored) throw new CategorizedError('write_error', `Row missing after write: ${filmId}`)
  const storedBeats = stored.dataPoints as unknown as Array<{ score: unknown }>
  const gapAfter = Math.abs(meanBeatScore(storedBeats) - stored.overallScore)
  try {
    assertMeanWithinTolerance(storedBeats, stored.overallScore)
  } catch (err) {
    throw new CategorizedError(
      'merge_out_of_tolerance',
      `Row written (${writeStatus}) but still drifts after merge: ${err instanceof Error ? err.message : String(err)}`,
      { mean: meanBeatScore(storedBeats), overall: stored.overallScore, gap: gapAfter }
    )
  }

  return { beatCount: graph.dataPoints.length, writeStatus, gapAfter }
}

// ── Batch helpers ────────────────────────────────────────────────────────────

const anthropicApiKey = process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY
const anthropic = anthropicApiKey ? new Anthropic({ apiKey: anthropicApiKey }) : null

async function pollUntilEnded(batchId: string): Promise<Anthropic.Messages.Batches.MessageBatch> {
  if (!anthropic) throw new Error('No Anthropic API key (ANTHROPIC_API_KEY or CINEMA_ANTHROPIC_KEY)')
  for (;;) {
    const batch = await anthropic.messages.batches.retrieve(batchId)
    const c = batch.request_counts
    const total = c.processing + c.succeeded + c.errored + c.canceled + c.expired
    const done = total - c.processing
    console.log(
      `  [poll] ${batchId} status=${batch.processing_status} ${done}/${total} (succeeded=${c.succeeded} errored=${c.errored} canceled=${c.canceled} expired=${c.expired})`
    )
    if (batch.processing_status === 'ended') return batch
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

function recordFailure(
  checkpoint: Checkpoint,
  tally: RunTally,
  params: {
    filmId: string
    title: string
    tier: Tier
    gapBefore: number
    attempts: number
    category: FailureCategory
    error: string
    meanInfo?: { mean: number; overall: number; gap: number }
    usage?: { inputTokens: number; outputTokens: number }
  }
): void {
  const { filmId, title, tier, gapBefore, attempts, category, error, meanInfo, usage } = params
  const terminal = !RETRYABLE_CATEGORIES.has(category) || attempts >= MAX_ATTEMPTS
  checkpoint.films[filmId] = {
    status: 'failed',
    tier,
    attempts,
    timestamp: new Date().toISOString(),
    gapBefore,
    category,
    error,
    lastMean: meanInfo?.mean,
    lastOverall: meanInfo?.overall,
    lastGap: meanInfo?.gap,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  }
  tally.failed++
  if (terminal) tally.failedTerminal++
  tally.byCategory[category] = (tally.byCategory[category] ?? 0) + 1
  logFailure({
    tier,
    filmId,
    title,
    category,
    terminal,
    error,
    gapBefore,
    attempts,
    lastMean: meanInfo?.mean,
    lastOverall: meanInfo?.overall,
    lastGap: meanInfo?.gap,
  })
  console.log(`  ✗ ${filmId} "${title}" ${category}${terminal ? '' : ' (retryable)'}: ${error}`)
}

async function processBatch(params: {
  batch: CheckpointBatch
  checkpoint: Checkpoint
  tally: RunTally
  titles: Map<string, string>
  gaps: Map<string, number>
  writeMode: 'safe' | 'force'
  forceWhenUnrated: boolean
}): Promise<void> {
  const { batch, checkpoint, tally, titles, gaps, writeMode, forceWhenUnrated } = params
  if (!anthropic) throw new Error('No Anthropic API key (ANTHROPIC_API_KEY or CINEMA_ANTHROPIC_KEY)')

  await pollUntilEnded(batch.id)
  console.log(`  [apply] downloading results for ${batch.id}`)
  const decoder = await anthropic.messages.batches.results(batch.id)
  const seen = new Set<string>()

  for await (const entry of decoder) {
    const filmId = entry.custom_id
    seen.add(filmId)
    const title = titles.get(filmId) ?? '?'
    const gapBefore = gaps.get(filmId) ?? checkpoint.films[filmId]?.gapBefore ?? Number.NaN
    const attempts = (checkpoint.films[filmId]?.attempts ?? 0) + 1
    const common = { filmId, title, tier: batch.tier, gapBefore, attempts }

    if (entry.result.type === 'succeeded') {
      const message = entry.result.message
      const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }
      tally.inputTokens += usage.inputTokens
      tally.outputTokens += usage.outputTokens
      const responseText = message.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
      try {
        const graph = parseAndValidate(responseText)
        const mode = await resolveWriteMode(filmId, writeMode, forceWhenUnrated)
        tally.byWriteMode[mode] = (tally.byWriteMode[mode] ?? 0) + 1
        const { beatCount, writeStatus, gapAfter } = await applyResult(filmId, graph, mode)
        checkpoint.films[filmId] = {
          status: 'success',
          tier: batch.tier,
          attempts,
          timestamp: new Date().toISOString(),
          gapBefore,
          beatCount,
          writeStatus,
          gapAfter,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        }
        tally.succeeded++
        console.log(
          `  ✓ ${filmId} "${title}" ${beatCount} beats, score ${graph.overallSentiment}, gap ${gapBefore.toFixed(3)} -> ${gapAfter.toFixed(3)} (${writeStatus})`
        )
      } catch (err) {
        const e = err instanceof CategorizedError ? err : new CategorizedError('validation', String(err))
        recordFailure(checkpoint, tally, { ...common, category: e.category, error: e.message, meanInfo: e.meanInfo, usage })
      }
    } else if (entry.result.type === 'errored') {
      const msg = entry.result.error.error?.message ?? 'Unknown batch request error'
      recordFailure(checkpoint, tally, { ...common, category: 'batch_errored', error: msg })
    } else if (entry.result.type === 'canceled') {
      recordFailure(checkpoint, tally, { ...common, category: 'batch_canceled', error: 'batch canceled' })
    } else {
      recordFailure(checkpoint, tally, { ...common, category: 'batch_expired', error: 'batch expired (24h timeout)' })
    }
    saveCheckpoint(checkpoint)
  }

  // A film we submitted but got no result line for is a failure too.
  for (const filmId of batch.filmIds) {
    if (seen.has(filmId)) continue
    recordFailure(checkpoint, tally, {
      filmId,
      title: titles.get(filmId) ?? '?',
      tier: batch.tier,
      gapBefore: gaps.get(filmId) ?? Number.NaN,
      attempts: (checkpoint.films[filmId]?.attempts ?? 0) + 1,
      category: 'batch_errored',
      error: 'no result returned for this custom_id',
    })
  }

  delete checkpoint.batch
  saveCheckpoint(checkpoint)
}

function failureRate(tally: RunTally, basis: 'all' | 'terminal'): number {
  if (tally.attempted === 0) return 0
  return (basis === 'terminal' ? tally.failedTerminal : tally.failed) / tally.attempted
}

function printReport(args: Args, tally: RunTally, stoppedEarly: boolean): void {
  const rate = failureRate(tally, args.failureRateBasis)
  const cost =
    (tally.inputTokens / 1_000_000) * BATCH_PRICE_PER_MTOK_INPUT +
    (tally.outputTokens / 1_000_000) * BATCH_PRICE_PER_MTOK_OUTPUT
  const writeMode = args.forceOrphan
    ? 'force-orphan'
    : args.forceWhenUnrated
      ? 'force-when-unrated (safe merge for films with beat ratings)'
      : 'safe (beat-lock merge)'
  console.log('\n=== RUN REPORT ===')
  console.log(`  tier:            ${args.tier}`)
  console.log(`  write mode:      ${writeMode}`)
  console.log(`  attempted:       ${tally.attempted}`)
  console.log(`  succeeded:       ${tally.succeeded}`)
  console.log(`  failed:          ${tally.failed} total, ${tally.failedTerminal} terminal`)
  console.log(`  failure rate:    ${(rate * 100).toFixed(2)}% (basis: ${args.failureRateBasis}; limit ${(args.maxFailureRate * 100).toFixed(0)}%)`)
  console.log(`  skipped:         ${tally.skipped}  (not counted as attempts)`)
  for (const [category, n] of Object.entries(tally.byCategory).sort()) {
    console.log(`    ${category.padEnd(24)} ${n}`)
  }
  for (const [mode, n] of Object.entries(tally.byWriteMode).sort()) {
    console.log(`    written via ${mode.padEnd(12)} ${n}`)
  }
  console.log(`  tokens:          ${tally.inputTokens} in, ${tally.outputTokens} out (approx $${cost.toFixed(2)} at batch pricing)`)
  console.log(`  failure log:     ${FAILURE_LOG}`)
  console.log(`  checkpoint:      ${CHECKPOINT_PATH}`)
  if (stoppedEarly) {
    console.log(
      `\nSTOPPED: ${args.failureRateBasis} failure rate ${(rate * 100).toFixed(2)}% exceeds ${(args.maxFailureRate * 100).toFixed(0)}%. No further chunks were submitted.`
    )
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const host = databaseHost()
  console.log(`[db] host=${host}`)
  if (args.expectHost && !host.includes(args.expectHost)) {
    console.error(`[db] host does not contain "${args.expectHost}"; aborting before any read or write`)
    process.exit(1)
  }
  console.log('backfill-graph-mean-drift:', { ...args, filmIds: args.filmIds ? [...args.filmIds] : null })
  if (args.commit && !anthropic) {
    console.error('No Anthropic API key found (ANTHROPIC_API_KEY or CINEMA_ANTHROPIC_KEY)')
    process.exit(1)
  }
  await confirmForceOrphan(args)

  const writeMode: 'safe' | 'force' = args.forceOrphan ? 'force' : 'safe'
  const checkpoint = loadCheckpoint()
  const tally: RunTally = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    failedTerminal: 0,
    skipped: 0,
    inputTokens: 0,
    outputTokens: 0,
    byCategory: {},
    byWriteMode: {},
  }
  const titles = new Map<string, string>()
  const gaps = new Map<string, number>()

  // Resume: finish an in-flight batch before selecting anything new.
  if (args.commit && checkpoint.batch) {
    const inflight = checkpoint.batch
    console.log(`Found in-flight batch ${inflight.id} (${inflight.filmIds.length} films, submitted ${inflight.submittedAt}); resuming`)
    const films = await prisma.film.findMany({ where: { id: { in: inflight.filmIds } }, select: { id: true, title: true } })
    for (const f of films) titles.set(f.id, f.title)
    tally.attempted += inflight.filmIds.length
    await processBatch({ batch: inflight, checkpoint, tally, titles, gaps, writeMode, forceWhenUnrated: args.forceWhenUnrated })
    if (failureRate(tally, args.failureRateBasis) > args.maxFailureRate) {
      printReport(args, tally, true)
      await prisma.$disconnect()
      process.exit(2)
    }
  }

  const drifting = await selectDriftingGraphs(args.tier)
  for (const r of drifting) {
    titles.set(r.filmId, r.title)
    gaps.set(r.filmId, r.gap)
  }
  console.log(`Selected ${drifting.length} graphs over tolerance for tier "${args.tier}" (largest gap ${drifting[0]?.gap.toFixed(3) ?? 'n/a'})`)

  let pending = drifting.filter((r) => isPending(checkpoint.films[r.filmId]))
  if (args.filmIds) {
    pending = pending.filter((r) => args.filmIds!.has(r.filmId))
    console.log(`--film-ids active: requested=${args.filmIds.size} matched-and-pending=${pending.length}`)
  }
  if (args.limit) pending = pending.slice(0, args.limit)
  const retrying = pending.filter((r) => checkpoint.films[r.filmId]?.status === 'failed').length
  console.log(`Pending this run: ${pending.length} (${retrying} retries carrying a corrective note)`)

  if (pending.length === 0) {
    console.log('Nothing to do.')
    printReport(args, tally, false)
    await prisma.$disconnect()
    return
  }

  let stoppedEarly = false
  let dryRunPromptChars = 0
  let dryRunBuilt = 0
  const dryRunModes = { hybrid: 0, review_only_fallback: 0 }

  for (let offset = 0; offset < pending.length; offset += args.chunkSize) {
    const chunkRows = pending.slice(offset, offset + args.chunkSize)
    const chunkNo = Math.floor(offset / args.chunkSize) + 1
    const chunkCount = Math.ceil(pending.length / args.chunkSize)
    console.log(`\n--- chunk ${chunkNo}/${chunkCount}: ${chunkRows.length} films ---`)

    const films = await prisma.film.findMany({ where: { id: { in: chunkRows.map((r) => r.filmId) } } })
    const filmById = new Map(films.map((f) => [f.id, f]))
    const requests: Anthropic.Messages.Batches.BatchCreateParams.Request[] = []

    for (const row of chunkRows) {
      const film = filmById.get(row.filmId)
      if (!film) {
        console.log(`  ? ${row.filmId} "${row.title}" no longer exists; skipping`)
        continue
      }
      const prior = checkpoint.films[film.id]
      const outcome = await buildRequestForFilm(film, prior, { skipPlotFetch: args.skipPlotFetch })
      if (outcome.kind === 'skipped') {
        tally.skipped++
        console.log(`  - ${film.id} "${film.title}" ${outcome.status}: ${outcome.reason}`)
        if (!args.dryRun) {
          checkpoint.films[film.id] = {
            status: outcome.status,
            tier: args.tier,
            attempts: prior?.attempts ?? 0,
            timestamp: new Date().toISOString(),
            gapBefore: row.gap,
            error: outcome.reason,
          }
          saveCheckpoint(checkpoint)
        }
        continue
      }
      requests.push(outcome.request)
      dryRunModes[outcome.generationMode]++
      dryRunPromptChars += outcome.promptChars
      dryRunBuilt++
      if (args.dryRun) {
        console.log(`  [${outcome.generationMode}] ${film.id} "${film.title}" gap ${row.gap.toFixed(3)}${prior?.status === 'failed' ? ' (retry, corrective note)' : ''}`)
      }
    }

    if (args.dryRun) continue
    if (requests.length === 0) {
      console.log('  nothing to submit in this chunk')
      continue
    }

    console.log(`  submitting ${requests.length} requests...`)
    const submitted = await anthropic!.messages.batches.create({ requests })
    const batch: CheckpointBatch = {
      id: submitted.id,
      submittedAt: submitted.created_at,
      filmIds: requests.map((r) => r.custom_id),
      tier: args.tier,
    }
    checkpoint.batch = batch
    saveCheckpoint(checkpoint)
    tally.attempted += requests.length
    console.log(`  batch ${submitted.id} submitted`)

    await processBatch({ batch, checkpoint, tally, titles, gaps, writeMode, forceWhenUnrated: args.forceWhenUnrated })

    const rate = failureRate(tally, args.failureRateBasis)
    console.log(
      `  chunk ${chunkNo} done. cumulative: attempted=${tally.attempted} succeeded=${tally.succeeded} failed=${tally.failed} (terminal ${tally.failedTerminal}) ${args.failureRateBasis} rate=${(rate * 100).toFixed(2)}%`
    )
    if (rate > args.maxFailureRate) {
      stoppedEarly = true
      break
    }
  }

  if (args.dryRun) {
    const inputTokens = Math.round(dryRunPromptChars / 4)
    const cost =
      (inputTokens / 1_000_000) * BATCH_PRICE_PER_MTOK_INPUT +
      ((dryRunBuilt * ESTIMATED_OUTPUT_TOKENS) / 1_000_000) * BATCH_PRICE_PER_MTOK_OUTPUT
    console.log('\n=== DRY RUN ===')
    console.log(`  would submit:    ${dryRunBuilt} requests (hybrid=${dryRunModes.hybrid} review_only_fallback=${dryRunModes.review_only_fallback})`)
    console.log(`  skipped:         ${tally.skipped}`)
    console.log(`  est. input:      ~${inputTokens} tokens (${Math.round(inputTokens / Math.max(dryRunBuilt, 1))} per request); est. output ~${ESTIMATED_OUTPUT_TOKENS} per request`)
    console.log(`  est. cost:       ~$${cost.toFixed(2)} for one attempt per film at batch pricing; add the same per-film cost for every retry`)
    if (args.skipPlotFetch) console.log('  (plots not fetched: every prompt sized as hybrid with a full-length plot placeholder)')
    console.log('  No batch submitted, no Claude calls, no DB writes, no checkpoint written.')
    await prisma.$disconnect()
    return
  }

  printReport(args, tally, stoppedEarly)
  await prisma.$disconnect()
  if (stoppedEarly) process.exit(2)
}

main().catch(async (err) => {
  console.error('Fatal:', err)
  try {
    await prisma.$disconnect()
  } catch {
    // ignore
  }
  process.exit(1)
})
