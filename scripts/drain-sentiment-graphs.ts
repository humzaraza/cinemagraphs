/**
 * Piece 2: one-shot sentiment-graph drain via the Anthropic Batch API.
 *
 * Selects every ACTIVE, released film with no sentiment graph and at least
 * one stored review, preps each one (stored reviews only, no live refresh),
 * submits ONE message batch, polls until it ends (no serverless time budget
 * applies locally), stores every result through the same
 * storeSentimentGraphResult chokepoint the cron uses, and clears its state.
 *
 * Pending state lives under its OWN siteSettings key
 * ('pending_sentiment_batch_bulk'), NOT the cron's 'pending_sentiment_batch'.
 * Deliberate: the cron's Stage A would adopt the batch and then try to
 * process thousands of results inside a 280s budget, get killed mid-write,
 * and never clear the key. The cron may submit its own small batch while
 * this drain is in flight; worst case is ~10 films analyzed twice, which is
 * cents. Crash-safe: rerunning the script resumes polling from the pending
 * state instead of resubmitting.
 *
 * Cost guard: prints the token-derived cost estimate BEFORE submitting and
 * aborts if it exceeds COST_CEILING_USD.
 *
 * GATED: spends real Claude budget and writes to the shared Neon database.
 * Do not run without explicit go-ahead.
 *
 * Usage:
 *   npx tsx scripts/drain-sentiment-graphs.ts --dry-run  # prep + cost estimate, no submit
 *   npx tsx scripts/drain-sentiment-graphs.ts            # the real thing
 */
import './_load-env'
import './_neon-ws'

import { appendFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import {
  prepareSentimentGraphInput,
  storeSentimentGraphResult,
  type SentimentGraphInput,
} from '../src/lib/sentiment-pipeline'
import {
  analyzeSentimentBatch,
  getBatchStatus,
  fetchBatchResults,
  estimateSentimentCost,
  type ParseGraphContext,
  type UsageTotals,
} from '../src/lib/claude'
import { invalidateFilmCache, invalidateHomepageCache } from '../src/lib/cache'
import type { Prisma } from '../src/generated/prisma/client'

const PENDING_KEY = 'pending_sentiment_batch_bulk'
const POLL_INTERVAL_MS = 30_000
const COST_CEILING_USD = 150
const PREP_DELAY_MS = 150
const RUN_LOG = 'drain-sentiment-graphs-run.jsonl'

interface PendingJob {
  filmId: string
  title: string
  reviewHash: string
  filteredReviewCount: number
  sources: string[]
}

interface PendingState {
  batchId: string
  submittedAt: string
  jobs: PendingJob[]
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function logEvent(event: Record<string, unknown>): void {
  try {
    appendFileSync(RUN_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`)
  } catch {
    // Logging failures must never kill the drain.
  }
}

let aborted = false
function requestAbort(signal: string) {
  if (aborted) process.exit(130)
  aborted = true
  console.log(
    `\n${signal}: stopping at the next safe point. A submitted batch keeps processing on Anthropic's side; rerun this script to resume polling it.`
  )
}
process.on('SIGINT', () => requestAbort('SIGINT'))
process.on('SIGTERM', () => requestAbort('SIGTERM'))

async function readPending(): Promise<PendingState | null> {
  const row = await prisma.siteSettings.findUnique({ where: { key: PENDING_KEY } })
  return row ? (row.value as unknown as PendingState) : null
}

async function writePending(state: PendingState): Promise<void> {
  await prisma.siteSettings.upsert({
    where: { key: PENDING_KEY },
    create: { key: PENDING_KEY, value: state as unknown as Prisma.InputJsonValue },
    update: { value: state as unknown as Prisma.InputJsonValue },
  })
}

async function clearPending(): Promise<void> {
  await prisma.siteSettings.deleteMany({ where: { key: PENDING_KEY } })
}

async function pollAndProcess(state: PendingState): Promise<void> {
  console.log(`Polling batch ${state.batchId} (${state.jobs.length} jobs, submitted ${state.submittedAt})`)
  let polls = 0
  for (;;) {
    if (aborted) {
      console.log('Aborted during polling. Pending state kept; rerun to resume.')
      process.exit(130)
    }
    const status = await getBatchStatus(state.batchId)
    polls++
    if (status.processingStatus === 'ended') break
    if (polls % 10 === 1) {
      console.log(
        `  processing: ${status.requestCounts.processing}, succeeded: ${status.requestCounts.succeeded}, errored: ${status.requestCounts.errored}`
      )
    }
    await sleep(POLL_INTERVAL_MS)
  }

  console.log('Batch ended. Fetching results...')
  const contextMap = new Map<string, ParseGraphContext>(
    state.jobs.map((j) => [j.filmId, { reviewCount: j.filteredReviewCount, sources: j.sources }])
  )
  const results = await fetchBatchResults(state.batchId, contextMap)
  const jobByFilmId = new Map(state.jobs.map((j) => [j.filmId, j]))

  let generated = 0
  let failed = 0
  let expired = 0
  let canceled = 0
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const job = jobByFilmId.get(result.customId)
    if (!job) {
      console.warn(`unknown filmId in results: ${result.customId}`)
      continue
    }

    if (result.usage) {
      totals.inputTokens += result.usage.inputTokens
      totals.outputTokens += result.usage.outputTokens
      totals.cacheReadInputTokens += result.usage.cacheReadInputTokens
      totals.cacheCreationInputTokens += result.usage.cacheCreationInputTokens
    }

    if (result.outcome === 'succeeded' && result.data) {
      const film = await prisma.film.findUnique({ where: { id: job.filmId } })
      if (!film) {
        failed++
        logEvent({ event: 'failed', filmId: job.filmId, title: job.title, reason: 'film vanished' })
        continue
      }
      // Minimal input reconstruction, mirroring cron/analyze:
      // storeSentimentGraphResult only reads film, filteredReviewCount, reviewHash.
      const input: SentimentGraphInput = {
        film,
        reviews: [],
        filteredReviewCount: job.filteredReviewCount,
        anchorScores: {
          imdbRating: film.imdbRating,
          rtCriticsScore: film.rtCriticsScore,
          rtAudienceScore: film.rtAudienceScore,
          metacriticScore: film.metacriticScore,
        },
        plotContext: { text: '', source: 'reviews_only' },
        reviewHash: job.reviewHash,
        promptParts: { system: '', user: '' },
      }
      try {
        await storeSentimentGraphResult(input, result.data, 'script-batch-analyze')
        await invalidateFilmCache(film.id)
        generated++
        logEvent({ event: 'generated', filmId: film.id, title: film.title })
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`store failed for ${film.title}: ${msg}`)
        logEvent({ event: 'failed', filmId: film.id, title: film.title, reason: msg.slice(0, 200) })
      }
    } else if (result.outcome === 'errored') {
      failed++
      logEvent({ event: 'errored', filmId: job.filmId, title: job.title, reason: result.error ?? 'errored' })
    } else if (result.outcome === 'expired') {
      expired++
      logEvent({ event: 'expired', filmId: job.filmId, title: job.title })
    } else {
      canceled++
      logEvent({ event: 'canceled', filmId: job.filmId, title: job.title })
    }

    if ((i + 1) % 200 === 0) {
      console.log(`  stored ${i + 1}/${results.length} results...`)
    }
  }

  await clearPending()
  await invalidateHomepageCache()

  const cost = estimateSentimentCost(totals, { isBatch: true })
  console.log('\n=== DRAIN COMPLETE ===')
  console.log(`Generated: ${generated}`)
  console.log(`Failed:    ${failed}`)
  console.log(`Expired:   ${expired}`)
  console.log(`Canceled:  ${canceled}`)
  console.log(
    `Tokens: ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out / ${totals.cacheReadInputTokens.toLocaleString()} cache-read / ${totals.cacheCreationInputTokens.toLocaleString()} cache-write`
  )
  console.log(`ACTUAL COST (batch pricing): $${cost.toFixed(2)}`)
  logEvent({ event: 'drain_complete', generated, failed, expired, canceled, totals, costUsd: Number(cost.toFixed(2)) })
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  // Resume a batch from a previous interrupted run.
  const pending = await readPending()
  if (pending) {
    console.log('Found pending bulk batch from a previous run; resuming.')
    await pollAndProcess(pending)
    await prisma.$disconnect()
    return
  }

  // ── Prep ──
  const candidates = await prisma.film.findMany({
    where: {
      status: 'ACTIVE',
      sentimentGraph: { is: null },
      reviews: { some: {} },
      OR: [{ releaseDate: null }, { releaseDate: { lte: new Date() } }],
    },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`Candidates (no graph, has reviews, released): ${candidates.length}`)

  const ready: SentimentGraphInput[] = []
  const tally = { insufficient: 0, preRelease: 0, notFound: 0, unchanged: 0, prepError: 0 }

  for (let i = 0; i < candidates.length; i++) {
    if (aborted) {
      console.log(`Aborted during prep at ${i}/${candidates.length}. Nothing submitted; rerun to start over.`)
      process.exit(130)
    }
    const c = candidates[i]
    try {
      const prep = await prepareSentimentGraphInput(c.id, { skipReviewRefresh: true })
      if (prep.status === 'ready') ready.push(prep.input)
      else if (prep.status === 'skipped_insufficient_reviews') tally.insufficient++
      else if (prep.status === 'skipped_pre_release') tally.preRelease++
      else if (prep.status === 'skipped_unchanged') tally.unchanged++
      else tally.notFound++
    } catch (err) {
      tally.prepError++
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`prep failed for ${c.title}: ${msg.slice(0, 150)}`)
      logEvent({ event: 'prep_error', filmId: c.id, title: c.title, reason: msg.slice(0, 200) })
    }
    if ((i + 1) % 100 === 0) {
      console.log(`  prepped ${i + 1}/${candidates.length} (ready ${ready.length})`)
    }
    await sleep(PREP_DELAY_MS)
  }

  // ── Cost estimate and ceiling guard ──
  const inputChars = ready.reduce((a, r) => a + r.promptParts.system.length + r.promptParts.user.length, 0)
  const estInputTokens = Math.round(inputChars / 4)
  const estOutputTokens = ready.length * 2500
  const estCost = (estInputTokens / 1e6) * 1.5 + (estOutputTokens / 1e6) * 7.5

  console.log('\n=== PRE-SUBMIT SUMMARY ===')
  console.log(`Ready to submit: ${ready.length}`)
  console.log(`Skipped: insufficient ${tally.insufficient}, preRelease ${tally.preRelease}, unchanged ${tally.unchanged}, notFound ${tally.notFound}, prepError ${tally.prepError}`)
  console.log(`Estimated input tokens: ${estInputTokens.toLocaleString()} (chars/4)`)
  console.log(`Estimated cost at batch pricing: $${estCost.toFixed(2)} (ceiling $${COST_CEILING_USD})`)
  logEvent({ event: 'pre_submit', ready: ready.length, tally, estInputTokens, estCostUsd: Number(estCost.toFixed(2)) })

  if (estCost > COST_CEILING_USD) {
    console.error(`Estimate exceeds the $${COST_CEILING_USD} ceiling. NOT submitting. Raise COST_CEILING_USD only with explicit approval.`)
    await prisma.$disconnect()
    process.exit(1)
  }
  if (dryRun) {
    console.log('Dry run: stopping before submission.')
    await prisma.$disconnect()
    return
  }
  if (ready.length === 0) {
    console.log('Nothing to submit.')
    await prisma.$disconnect()
    return
  }

  // ── Submit ONE batch ──
  const submit = await analyzeSentimentBatch(
    ready.map((input) => ({
      customId: input.film.id,
      system: input.promptParts.system,
      user: input.promptParts.user,
    }))
  )
  const jobs: PendingJob[] = ready.map((input) => ({
    filmId: input.film.id,
    title: input.film.title,
    reviewHash: input.reviewHash,
    filteredReviewCount: input.filteredReviewCount,
    sources: [...new Set(input.reviews.map((r) => r.sourcePlatform.toLowerCase()))],
  }))
  const state: PendingState = { batchId: submit.batchId, submittedAt: submit.submittedAt, jobs }
  await writePending(state)
  console.log(`Submitted batch ${submit.batchId} with ${jobs.length} requests. State persisted under ${PENDING_KEY}.`)
  logEvent({ event: 'submitted', batchId: submit.batchId, jobs: jobs.length })

  await pollAndProcess(state)
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('Fatal error:', err)
  logEvent({ event: 'fatal', error: err instanceof Error ? err.message : String(err) })
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
