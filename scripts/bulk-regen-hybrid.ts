/**
 * One-off bulk regeneration of SentimentGraph.dataPoints for every Film row
 * via Anthropic's Message Batches API (sequential Claude calls would cost
 * roughly double).
 *
 * Flow:
 *   1. Pre-submission skip pass: load each pending film, categorize pre-release /
 *      no-reviews / no-plot-no-reviews into the checkpoint. Remaining films get
 *      a hybrid prompt (Wikipedia plot) or review-only fallback prompt built
 *      in memory.
 *   2. Submit one batch (limit 10,000 per submission; ~1,339 fits).
 *   3. Poll batch status every 30s until `ended`. Checkpoint stores the batch
 *      id + expected film ids so a crashed run resumes by polling, not
 *      resubmitting.
 *   4. Stream the JSONL results. For each succeeded response parse + validate
 *      beats (8–22), then forceOverwriteSentimentGraph. Errored/canceled/
 *      expired entries get categorized into the same skip buckets as the
 *      sequential script.
 *
 * Resumable via `.hybrid-regen-checkpoint.json` (gitignored). Pre-release films,
 * films with <3 quality reviews, and films with no plot and no reviews are
 * skipped and logged with specific status categories.
 *
 * Usage:
 *   npx tsx scripts/bulk-regen-hybrid.ts --dry-run                # build requests in memory only
 *   npx tsx scripts/bulk-regen-hybrid.ts --dry-run --limit 5      # build 5 in memory
 *   npx tsx scripts/bulk-regen-hybrid.ts --commit                 # submit/poll/apply
 *   npx tsx scripts/bulk-regen-hybrid.ts --commit --limit 10      # submit first 10 pending
 *
 * Do NOT run --commit without an approved cost plan.
 *
 * NOTE on module evaluation order: Any module that reads `process.env` at
 * load time (prisma.ts, hybrid-sentiment.ts, claude.ts) or transitively
 * imports src/lib/prisma.ts (sentiment-beat-lock.ts, sentiment-pipeline.ts)
 * MUST be loaded after dotenv has populated env. ES modules evaluate all
 * static imports before the importing module's top-level code runs, so those
 * modules are loaded via dynamic `await import(...)` inside `main()` — after
 * the top-level `dotenv.config(...)` call below has run. Reverting these to
 * static imports silently breaks `forceOverwriteSentimentGraph` by binding
 * the shared PrismaClient to `host=localhost` before DATABASE_URL is set.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import fs from 'node:fs'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { PrismaClient, type Film } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import { fetchWikipediaPlot } from '../src/lib/sources/wikipedia'
import type { AnchorScores } from '../src/lib/omdb'
import type { ParsedGraph } from '../src/lib/hybrid-sentiment'

// Bindings populated inside main() via dynamic import, AFTER dotenv.config()
// above has run. DO NOT convert to static imports — see NOTE in the header.
let forceOverwriteSentimentGraph!: typeof import('../src/lib/sentiment-beat-lock')['forceOverwriteSentimentGraph']
let isQualityReview!: typeof import('../src/lib/sentiment-pipeline')['isQualityReview']
let SENTIMENT_MODEL!: typeof import('../src/lib/claude')['SENTIMENT_MODEL']
let SENTIMENT_MAX_TOKENS!: typeof import('../src/lib/claude')['SENTIMENT_MAX_TOKENS']
let buildAnalysisPromptParts!: typeof import('../src/lib/claude')['buildAnalysisPromptParts']
let MIN_QUALITY_REVIEWS!: typeof import('../src/lib/hybrid-sentiment')['MIN_QUALITY_REVIEWS']
let buildAnchorString!: typeof import('../src/lib/hybrid-sentiment')['buildAnchorString']
let buildHybridPrompt!: typeof import('../src/lib/hybrid-sentiment')['buildHybridPrompt']
let computeHybridBeatCount!: typeof import('../src/lib/hybrid-sentiment')['computeHybridBeatCount']
let validateGraph!: typeof import('../src/lib/hybrid-sentiment')['validateGraph']

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY
if (!apiKey) {
  console.error('No Anthropic API key found (ANTHROPIC_API_KEY or CINEMA_ANTHROPIC_KEY)')
  process.exit(1)
}
const anthropic = new Anthropic({ apiKey })

const CHECKPOINT_PATH = path.resolve('.hybrid-regen-checkpoint.json')
const CHECKPOINT_TMP = `${CHECKPOINT_PATH}.tmp`
const POLL_INTERVAL_MS = 30_000
const MAX_RETRIES = 2
const MAX_BATCH_SIZE = 10_000

// ── Types ────────────────────────────────────────────────────────────────────

type CheckpointStatus =
  | 'success'
  | 'skipped_prerelease'
  | 'skipped_no_reviews'
  | 'skipped_no_plot_no_reviews'
  | 'failed'

interface CheckpointEntry {
  status: CheckpointStatus
  timestamp: string
  retryCount?: number
  error?: string
  beatCount?: number
  generationMode?: 'hybrid' | 'review_only_fallback'
  inputTokens?: number
  outputTokens?: number
}

interface CheckpointBatch {
  id: string
  submittedAt: string
  filmIds: string[]
}

interface Checkpoint {
  version: 2
  startedAt: string
  films: Record<string, CheckpointEntry>
  batch?: CheckpointBatch
}

interface Args {
  dryRun: boolean
  commit: boolean
  limit: number | null
  resume: boolean
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, commit: false, limit: null, resume: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--commit') args.commit = true
    else if (a === '--resume') args.resume = true
    else if (a === '--limit') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 1) throw new Error(`--limit requires a positive integer, got: ${argv[i]}`)
      args.limit = n
    }
  }
  if (!args.dryRun && !args.commit) throw new Error('Must pass --dry-run or --commit')
  if (args.dryRun && args.commit) throw new Error('Cannot pass both --dry-run and --commit')
  return args
}

// ── Checkpoint I/O ───────────────────────────────────────────────────────────

function emptyCheckpoint(): Checkpoint {
  return { version: 2, startedAt: new Date().toISOString(), films: {} }
}

function loadCheckpoint(): Checkpoint {
  if (!fs.existsSync(CHECKPOINT_PATH)) return emptyCheckpoint()
  let raw: string
  try {
    raw = fs.readFileSync(CHECKPOINT_PATH, 'utf8')
  } catch (err) {
    console.warn(`[checkpoint] read failed (${err instanceof Error ? err.message : err}), starting fresh`)
    return emptyCheckpoint()
  }
  if (!raw.trim()) {
    console.warn('[checkpoint] file empty, starting fresh')
    return emptyCheckpoint()
  }
  try {
    const parsed = JSON.parse(raw) as Checkpoint
    if (parsed.version !== 2) {
      console.warn(`[checkpoint] unexpected version ${parsed.version}, starting fresh`)
      return emptyCheckpoint()
    }
    if (!parsed.films || typeof parsed.films !== 'object') {
      console.warn('[checkpoint] missing films map, starting fresh')
      return emptyCheckpoint()
    }
    return parsed
  } catch (err) {
    console.warn(`[checkpoint] JSON parse failed (${err instanceof Error ? err.message : err}), starting fresh`)
    return emptyCheckpoint()
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  fs.writeFileSync(CHECKPOINT_TMP, JSON.stringify(cp, null, 2))
  fs.renameSync(CHECKPOINT_TMP, CHECKPOINT_PATH)
}

function shouldSkipFromCheckpoint(entry: CheckpointEntry | undefined): boolean {
  if (!entry) return false
  if (entry.status === 'success') return true
  if (entry.status === 'skipped_prerelease') return true
  if (entry.status === 'skipped_no_reviews') return true
  if (entry.status === 'skipped_no_plot_no_reviews') return true
  if (entry.status === 'failed' && (entry.retryCount ?? 0) >= MAX_RETRIES) return true
  return false
}

function tallyByStatus(cp: Checkpoint): Record<CheckpointStatus, number> {
  const t: Record<CheckpointStatus, number> = {
    success: 0,
    skipped_prerelease: 0,
    skipped_no_reviews: 0,
    skipped_no_plot_no_reviews: 0,
    failed: 0,
  }
  for (const e of Object.values(cp.films)) t[e.status]++
  return t
}

function categorizeError(msg: string): CheckpointStatus {
  if (/Cannot generate sentiment for pre-release film/i.test(msg)) return 'skipped_prerelease'
  if (/Not enough quality reviews/i.test(msg)) return 'skipped_no_reviews'
  if (/wikipedia plot unavailable/i.test(msg) && /review count insufficient/i.test(msg)) {
    return 'skipped_no_plot_no_reviews'
  }
  return 'failed'
}

// ── Per-film request build ───────────────────────────────────────────────────

type BuildOutcome =
  | { kind: 'skipped'; status: 'skipped_prerelease' | 'skipped_no_reviews' | 'skipped_no_plot_no_reviews'; reason: string }
  | {
      kind: 'built'
      generationMode: 'hybrid' | 'review_only_fallback'
      request: Anthropic.Messages.Batches.BatchCreateParams.Request
    }

async function buildRequestForFilm(film: Film): Promise<BuildOutcome> {
  if (film.releaseDate && film.releaseDate > new Date()) {
    return {
      kind: 'skipped',
      status: 'skipped_prerelease',
      reason: `Cannot generate sentiment for pre-release film ${film.title}, releases ${film.releaseDate.toISOString()}`,
    }
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
  const runtime = film.runtime || 120

  const plotText =
    typeof year === 'number' ? await fetchWikipediaPlot(film.title, year) : null

  const anchorScores: AnchorScores = {
    imdbRating: film.imdbRating,
    rtCriticsScore: film.rtCriticsScore,
    rtAudienceScore: film.rtAudienceScore,
    metacriticScore: film.metacriticScore,
  }

  if (plotText) {
    const { anchorString, target } = buildAnchorString(film)
    const beatCount = computeHybridBeatCount(runtime)
    const user = buildHybridPrompt({
      film,
      year,
      runtime,
      anchorString,
      target,
      plotText,
      reviews: qualityReviews,
      beatCount,
    })
    return {
      kind: 'built',
      generationMode: 'hybrid',
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

  // Fallback: no Wikipedia plot available → review-only prompt. The existing
  // reviews-only pipeline caches the system prompt, so we keep that here.
  const parts = buildAnalysisPromptParts(film, qualityReviews, anchorScores, undefined)
  return {
    kind: 'built',
    generationMode: 'review_only_fallback',
    request: {
      custom_id: film.id,
      params: {
        model: SENTIMENT_MODEL,
        max_tokens: SENTIMENT_MAX_TOKENS,
        temperature: 0,
        system: [
          {
            type: 'text',
            text: parts.system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: parts.user }],
      },
    },
  }
}

// ── Write graph to DB ────────────────────────────────────────────────────────

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

async function applySuccessfulResult(filmId: string, graph: ParsedGraph): Promise<{ beatCount: number }> {
  if (graph.dataPoints.length < 8 || graph.dataPoints.length > 22) {
    throw new Error(
      `Beat count out of expected bounds: got ${graph.dataPoints.length}, expected 8–22`
    )
  }

  const film = await prisma.film.findUnique({
    where: { id: filmId },
    select: { id: true, imdbRating: true, rtCriticsScore: true, metacriticScore: true },
  })
  if (!film) throw new Error(`Film vanished between submit and apply: ${filmId}`)

  const existing = await prisma.sentimentGraph.findUnique({
    where: { filmId },
    select: { overallScore: true, version: true },
  })

  const reviews = await prisma.review.findMany({
    where: { filmId },
    select: { sourcePlatform: true, reviewText: true },
  })
  const qualityReviews = reviews.filter((r) => isQualityReview(r.reviewText))
  const sourcesUsed = [...new Set(qualityReviews.map((r) => r.sourcePlatform.toLowerCase()))]

  await forceOverwriteSentimentGraph({
    filmId,
    dataPoints: graph.dataPoints,
    otherFields: {
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
    },
    callerPath: 'script-bulk-regen-hybrid',
  })

  await prisma.film.update({
    where: { id: filmId },
    data: { lastReviewCount: qualityReviews.length },
  })

  return { beatCount: graph.dataPoints.length }
}

// ── Polling loop ─────────────────────────────────────────────────────────────

async function pollUntilEnded(batchId: string): Promise<Anthropic.Messages.Batches.MessageBatch> {
  while (true) {
    const batch = await anthropic.messages.batches.retrieve(batchId)
    const c = batch.request_counts
    const total = c.processing + c.succeeded + c.errored + c.canceled + c.expired
    const done = c.succeeded + c.errored + c.canceled + c.expired
    console.log(
      `[poll] status=${batch.processing_status} ${done}/${total} done (succeeded=${c.succeeded} errored=${c.errored} canceled=${c.canceled} expired=${c.expired} processing=${c.processing})`
    )
    if (batch.processing_status === 'ended') return batch
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log('bulk-regen-hybrid:', args)

  // Load env-dependent modules AFTER dotenv.config() has run. DO NOT convert
  // these to static imports — see NOTE in the header comment.
  const [sblMod, pipelineMod, claudeMod, hybridMod] = await Promise.all([
    import('../src/lib/sentiment-beat-lock'),
    import('../src/lib/sentiment-pipeline'),
    import('../src/lib/claude'),
    import('../src/lib/hybrid-sentiment'),
  ])
  forceOverwriteSentimentGraph = sblMod.forceOverwriteSentimentGraph
  isQualityReview = pipelineMod.isQualityReview
  SENTIMENT_MODEL = claudeMod.SENTIMENT_MODEL
  SENTIMENT_MAX_TOKENS = claudeMod.SENTIMENT_MAX_TOKENS
  buildAnalysisPromptParts = claudeMod.buildAnalysisPromptParts
  MIN_QUALITY_REVIEWS = hybridMod.MIN_QUALITY_REVIEWS
  buildAnchorString = hybridMod.buildAnchorString
  buildHybridPrompt = hybridMod.buildHybridPrompt
  computeHybridBeatCount = hybridMod.computeHybridBeatCount
  validateGraph = hybridMod.validateGraph

  const films = await prisma.film.findMany({ orderBy: { id: 'asc' } })
  console.log(`Loaded ${films.length} films from DB`)

  const checkpoint = loadCheckpoint()
  const priorEntries = Object.keys(checkpoint.films).length
  if (priorEntries > 0) console.log(`Checkpoint has ${priorEntries} prior entries`)

  // ── Resume path: if a batch is in flight, skip straight to polling + apply ──
  if (args.commit && checkpoint.batch) {
    const batchId = checkpoint.batch.id
    console.log(`Found in-flight batch ${batchId} (submitted ${checkpoint.batch.submittedAt}) — resuming`)
    const finalBatch = await pollUntilEnded(batchId)
    await processResults(batchId, checkpoint, finalBatch)
    return
  }

  // ── Build phase ─────────────────────────────────────────────────────────────
  const pending = films.filter((f) => !shouldSkipFromCheckpoint(checkpoint.films[f.id]))
  const toProcess = args.limit ? pending.slice(0, args.limit) : pending
  console.log(`Pending: ${pending.length} | Will build requests for: ${toProcess.length}`)

  const requests: Anthropic.Messages.Batches.BatchCreateParams.Request[] = []
  const modes: Record<string, 'hybrid' | 'review_only_fallback'> = {}
  const preSubSkipped: { filmId: string; title: string; status: CheckpointStatus; reason: string }[] = []

  let built = 0
  for (const film of toProcess) {
    const outcome = await buildRequestForFilm(film)
    if (outcome.kind === 'skipped') {
      preSubSkipped.push({ filmId: film.id, title: film.title, status: outcome.status, reason: outcome.reason })
      if (!args.dryRun) {
        checkpoint.films[film.id] = {
          status: outcome.status,
          timestamp: new Date().toISOString(),
          error: outcome.reason,
        }
        saveCheckpoint(checkpoint)
      }
    } else {
      requests.push(outcome.request)
      modes[film.id] = outcome.generationMode
      built++
      if (built % 50 === 0) console.log(`[build] ${built} requests built`)
    }
  }

  const modeCounts = Object.values(modes).reduce(
    (acc, m) => {
      acc[m]++
      return acc
    },
    { hybrid: 0, review_only_fallback: 0 } as Record<string, number>
  )
  console.log(
    `Built ${requests.length} requests | hybrid=${modeCounts.hybrid} review_only_fallback=${modeCounts.review_only_fallback}`
  )
  console.log(
    `Pre-submission skipped: ${preSubSkipped.length} (` +
      Object.entries(
        preSubSkipped.reduce(
          (acc, s) => {
            acc[s.status] = (acc[s.status] || 0) + 1
            return acc
          },
          {} as Record<string, number>
        )
      )
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') +
      ')'
  )

  if (args.dryRun) {
    console.log('\n--- DRY RUN: batch requests built in memory ---')
    for (const req of requests) {
      const film = films.find((f) => f.id === req.custom_id)
      console.log(`  [${modes[req.custom_id]}] custom_id=${req.custom_id} "${film?.title ?? '?'}"`)
    }
    if (preSubSkipped.length > 0) {
      console.log('\nPre-submission skips:')
      for (const s of preSubSkipped) {
        console.log(`  [${s.status}] ${s.filmId} "${s.title}" — ${s.reason}`)
      }
    }
    console.log('\nDry run complete. No batch submitted, no Claude calls, no DB writes, no checkpoint written.')
    await prisma.$disconnect()
    return
  }

  // ── Commit path ─────────────────────────────────────────────────────────────
  if (requests.length === 0) {
    console.log('Nothing to submit. Exiting.')
    await prisma.$disconnect()
    return
  }
  if (requests.length > MAX_BATCH_SIZE) {
    throw new Error(
      `Too many requests (${requests.length}) for a single batch (max ${MAX_BATCH_SIZE}). Re-run with --limit or add chunking.`
    )
  }

  console.log(`Submitting batch with ${requests.length} requests...`)
  const submitted = await anthropic.messages.batches.create({ requests })
  console.log(`Batch submitted: ${submitted.id} (created_at ${submitted.created_at})`)

  checkpoint.batch = {
    id: submitted.id,
    submittedAt: submitted.created_at,
    filmIds: requests.map((r) => r.custom_id),
  }
  saveCheckpoint(checkpoint)

  const finalBatch = await pollUntilEnded(submitted.id)
  await processResults(submitted.id, checkpoint, finalBatch)
}

async function processResults(
  batchId: string,
  checkpoint: Checkpoint,
  finalBatch: Anthropic.Messages.Batches.MessageBatch
) {
  console.log('\n--- Downloading & applying results ---')
  const startedAt = Date.now()

  const decoder = await anthropic.messages.batches.results(batchId)

  let processed = 0
  let inputTokens = 0
  let outputTokens = 0

  for await (const entry of decoder) {
    processed++
    const filmId = entry.custom_id
    const prior = checkpoint.films[filmId]
    const retryCount = prior?.status === 'failed' ? (prior.retryCount ?? 0) : 0

    if (entry.result.type === 'succeeded') {
      const message = entry.result.message
      inputTokens += message.usage.input_tokens
      outputTokens += message.usage.output_tokens

      const responseText = message.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')

      try {
        const cleaned = responseText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
        const parsed = JSON.parse(cleaned) as unknown
        const graph = validateGraph(parsed)
        const { beatCount } = await applySuccessfulResult(filmId, graph)
        checkpoint.films[filmId] = {
          status: 'success',
          timestamp: new Date().toISOString(),
          beatCount,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        }
        console.log(`  ✓ ${filmId} — ${beatCount} beats, score ${graph.overallSentiment}`)
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const status = categorizeError(error.message)
        checkpoint.films[filmId] = {
          status,
          timestamp: new Date().toISOString(),
          retryCount: status === 'failed' ? retryCount + 1 : retryCount,
          error: error.message,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        }
        console.log(`  ✗ ${filmId} — ${status}: ${error.message}`)
      }
    } else if (entry.result.type === 'errored') {
      const errMsg = entry.result.error.error?.message ?? 'Unknown batch request error'
      const status = categorizeError(errMsg)
      checkpoint.films[filmId] = {
        status,
        timestamp: new Date().toISOString(),
        retryCount: status === 'failed' ? retryCount + 1 : retryCount,
        error: `batch errored: ${errMsg}`,
      }
      console.log(`  ✗ ${filmId} — batch errored (${status}): ${errMsg}`)
    } else if (entry.result.type === 'canceled') {
      checkpoint.films[filmId] = {
        status: 'failed',
        timestamp: new Date().toISOString(),
        retryCount: retryCount + 1,
        error: 'batch canceled',
      }
      console.log(`  ✗ ${filmId} — canceled`)
    } else if (entry.result.type === 'expired') {
      checkpoint.films[filmId] = {
        status: 'failed',
        timestamp: new Date().toISOString(),
        retryCount: retryCount + 1,
        error: 'batch expired (24h timeout)',
      }
      console.log(`  ✗ ${filmId} — expired`)
    }

    saveCheckpoint(checkpoint)
  }

  // Batch fully processed — clear the in-flight marker so a subsequent run
  // doesn't think it still has to poll this batch.
  delete checkpoint.batch
  saveCheckpoint(checkpoint)

  const totalMs = Date.now() - startedAt
  const tallies = tallyByStatus(checkpoint)
  const cost = (inputTokens * 3) / 1_000_000 / 2 + (outputTokens * 15) / 1_000_000 / 2 // batch = 50%

  console.log('\n=== FINAL ===')
  console.log(`Batch id: ${batchId}`)
  console.log(`Batch final counts:`, finalBatch.request_counts)
  console.log(`Results processed this run: ${processed}`)
  console.log(`Duration (download + apply): ${(totalMs / 1000).toFixed(1)}s`)
  console.log(`Cumulative checkpoint tallies:`)
  console.log(`  success:                    ${tallies.success}`)
  console.log(`  skipped_prerelease:         ${tallies.skipped_prerelease}`)
  console.log(`  skipped_no_reviews:         ${tallies.skipped_no_reviews}`)
  console.log(`  skipped_no_plot_no_reviews: ${tallies.skipped_no_plot_no_reviews}`)
  console.log(`  failed:                     ${tallies.failed}`)
  console.log(
    `This run's Claude tokens: ${inputTokens} in, ${outputTokens} out → approx $${cost.toFixed(2)} (batch pricing: 50% of standard)`
  )

  const allFailedIds: string[] = []
  for (const [fid, entry] of Object.entries(checkpoint.films)) {
    if (entry.status === 'failed') allFailedIds.push(fid)
  }
  if (allFailedIds.length > 0) {
    console.log(`\nFailed filmIds (${allFailedIds.length}):`)
    for (const fid of allFailedIds) console.log(`  ${fid}`)
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('Fatal error:', e)
  process.exit(1)
})
