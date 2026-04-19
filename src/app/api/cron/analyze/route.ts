import { prisma } from '@/lib/prisma'
import {
  filmNeedsReanalysis,
  prepareSentimentGraphInput,
  storeSentimentGraphResult,
  type SentimentGraphInput,
} from '@/lib/sentiment-pipeline'
import {
  analyzeSentimentBatch,
  fetchBatchResults,
  getBatchStatus,
  estimateSentimentCost,
  sumUsage,
  type BatchResultEntry,
  type ParseGraphContext,
  type UsageTotals,
} from '@/lib/claude'
import { cronLogger } from '@/lib/logger'
import { invalidateFilmCache, invalidateHomepageCache } from '@/lib/cache'
import { decideCronRegen, type CronRegenDecision } from '@/lib/cron-skip-logic'
import type { Prisma } from '@/generated/prisma/client'

export const maxDuration = 300

const TIME_BUDGET_MS = 280_000 // Leave 20s buffer before maxDuration
const POLL_INTERVAL_MS = 8_000
const MAX_FILMS_PER_BATCH = 10
const PENDING_BATCH_KEY = 'pending_sentiment_batch'

interface PendingBatchJob {
  filmId: string
  reviewHash: string
  filteredReviewCount: number
  /** Pre-lowercased source platform names — what `parseGraphResponse` will
   *  coerce onto the result. */
  sources: string[]
}

interface PendingBatchState {
  batchId: string
  submittedAt: string
  jobs: PendingBatchJob[]
}

async function readPendingBatchState(): Promise<PendingBatchState | null> {
  const row = await prisma.siteSettings.findUnique({ where: { key: PENDING_BATCH_KEY } })
  if (!row) return null
  return row.value as unknown as PendingBatchState
}

async function writePendingBatchState(state: PendingBatchState): Promise<void> {
  await prisma.siteSettings.upsert({
    where: { key: PENDING_BATCH_KEY },
    create: {
      key: PENDING_BATCH_KEY,
      value: state as unknown as Prisma.InputJsonValue,
    },
    update: { value: state as unknown as Prisma.InputJsonValue },
  })
}

async function clearPendingBatchState(): Promise<void> {
  await prisma.siteSettings.deleteMany({ where: { key: PENDING_BATCH_KEY } })
}

function jobsToContextMap(jobs: PendingBatchJob[]): Map<string, ParseGraphContext> {
  return new Map(
    jobs.map((j) => [
      j.filmId,
      { reviewCount: j.filteredReviewCount, sources: j.sources },
    ])
  )
}

interface ProcessResultsSummary {
  generated: number
  failed: number
  expired: number
  canceled: number
  totals: UsageTotals
  perFilm: Array<{ title: string; status: string; reason?: string }>
}

/**
 * Convert batch result entries into stored sentiment graphs. Each successful
 * entry is matched to its persisted job by filmId, the corresponding film is
 * fetched, and `storeSentimentGraphResult` is called with the snapshot data.
 */
async function processBatchResults(
  results: BatchResultEntry[],
  jobs: PendingBatchJob[]
): Promise<ProcessResultsSummary> {
  const jobByFilmId = new Map(jobs.map((j) => [j.filmId, j]))
  const summary: ProcessResultsSummary = {
    generated: 0,
    failed: 0,
    expired: 0,
    canceled: 0,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    perFilm: [],
  }

  for (const result of results) {
    const job = jobByFilmId.get(result.customId)
    if (!job) {
      cronLogger.warn({ customId: result.customId }, 'Batch result has unknown filmId')
      continue
    }

    // Look up the film for storeSentimentGraphResult
    const film = await prisma.film.findUnique({ where: { id: job.filmId } })
    if (!film) {
      cronLogger.warn({ filmId: job.filmId }, 'Film vanished between submit and process')
      summary.failed++
      summary.perFilm.push({ title: job.filmId, status: 'failed', reason: 'film vanished' })
      continue
    }

    if (result.outcome === 'succeeded' && result.data) {
      // Build a minimal SentimentGraphInput. We only need the fields
      // storeSentimentGraphResult actually reads: film, filteredReviewCount, reviewHash.
      const input: SentimentGraphInput = {
        film,
        reviews: [], // unused by storeSentimentGraphResult
        filteredReviewCount: job.filteredReviewCount,
        anchorScores: {
          imdbRating: film.imdbRating,
          rtCriticsScore: film.rtCriticsScore,
          rtAudienceScore: film.rtAudienceScore,
          metacriticScore: film.metacriticScore,
        },
        plotContext: { text: '', source: 'reviews_only' }, // unused
        reviewHash: job.reviewHash,
        promptParts: { system: '', user: '' }, // unused
      }

      try {
        await storeSentimentGraphResult(input, result.data, 'cron-analyze')
        await invalidateFilmCache(film.id)
        summary.generated++
        summary.perFilm.push({ title: film.title, status: 'generated' })
      } catch (err) {
        cronLogger.error(
          { err, filmId: film.id, filmTitle: film.title },
          'Failed to store batch result'
        )
        summary.failed++
        summary.perFilm.push({
          title: film.title,
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    } else if (result.outcome === 'errored') {
      cronLogger.error(
        { filmId: film.id, filmTitle: film.title, error: result.error },
        'Batch request errored'
      )
      summary.failed++
      summary.perFilm.push({
        title: film.title,
        status: 'failed',
        reason: result.error || 'errored',
      })
    } else if (result.outcome === 'expired') {
      cronLogger.warn({ filmId: film.id, filmTitle: film.title }, 'Batch request expired')
      summary.expired++
      summary.perFilm.push({ title: film.title, status: 'expired' })
    } else {
      summary.canceled++
      summary.perFilm.push({ title: film.title, status: 'canceled' })
    }

    if (result.usage) {
      summary.totals.inputTokens += result.usage.inputTokens
      summary.totals.outputTokens += result.usage.outputTokens
      summary.totals.cacheReadInputTokens += result.usage.cacheReadInputTokens
      summary.totals.cacheCreationInputTokens += result.usage.cacheCreationInputTokens
    }
  }

  return summary
}

/** Poll a batch inline up to the supplied deadline. Returns the results if
 *  the batch ended in time, or null if we ran out of budget. */
async function pollBatchUntilDone(
  batchId: string,
  deadline: number,
  jobs: PendingBatchJob[]
): Promise<BatchResultEntry[] | null> {
  while (true) {
    const status = await getBatchStatus(batchId)
    if (status.processingStatus === 'ended') {
      return await fetchBatchResults(batchId, jobsToContextMap(jobs))
    }

    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      cronLogger.info(
        { batchId, processing: status.requestCounts.processing, succeeded: status.requestCounts.succeeded },
        'Time budget exhausted while polling batch — leaving for next run'
      )
      return null
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

function logCostSummary(stage: string, totals: UsageTotals, filmCount: number): void {
  const cost = estimateSentimentCost(totals, { isBatch: true })
  cronLogger.info(
    {
      stage,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadInputTokens: totals.cacheReadInputTokens,
      cacheCreationInputTokens: totals.cacheCreationInputTokens,
      estimatedUsd: Number(cost.toFixed(4)),
      filmsProcessed: filmCount,
      perFilmUsd: filmCount > 0 ? Number((cost / filmCount).toFixed(4)) : 0,
    },
    'Sentiment batch cost'
  )
}

export async function GET(request: Request) {
  const startTime = Date.now()
  const deadline = startTime + TIME_BUDGET_MS

  try {
    // ── Auth ──
    const authHeader = request.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
    }

    // ── Stage A: process any leftover batch from a prior cron run ──
    const pending = await readPendingBatchState()
    if (pending) {
      cronLogger.info(
        { batchId: pending.batchId, jobCount: pending.jobs.length, submittedAt: pending.submittedAt },
        'Found pending batch from previous run'
      )

      const results = await pollBatchUntilDone(pending.batchId, deadline, pending.jobs)
      if (results === null) {
        // Still in progress past our budget — leave state in place for next run
        return Response.json({
          stage: 'pending_batch_in_progress',
          batchId: pending.batchId,
          jobCount: pending.jobs.length,
          durationMs: Date.now() - startTime,
        })
      }

      const summary = await processBatchResults(results, pending.jobs)
      await clearPendingBatchState()
      logCostSummary('resumed_batch', summary.totals, summary.generated)
      if (summary.generated > 0) await invalidateHomepageCache()

      // Note: we intentionally do NOT submit a new batch in the same run
      // after resuming an old one. Leave fresh work for the next cron tick to
      // keep wall-clock simple and predictable.
      cronLogger.info(
        {
          stage: 'resumed_batch',
          generated: summary.generated,
          failed: summary.failed,
          expired: summary.expired,
          canceled: summary.canceled,
          durationMs: Date.now() - startTime,
        },
        'Resumed batch processed'
      )
      return Response.json({
        stage: 'resumed_batch',
        batchId: pending.batchId,
        ...summary,
        estimatedUsd: Number(estimateSentimentCost(summary.totals, { isBatch: true }).toFixed(4)),
        durationMs: Date.now() - startTime,
      })
    }

    // ── Stage B: find candidates for a new batch ──
    // Daily cron: most mature films will skip via decideCronRegen, so we pull
    // a wider pool than the per-batch cap. Candidates are ordered by oldest
    // sentiment graph first, so stale films rise to the top.
    const candidates = await prisma.film.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { releaseDate: null },
          { releaseDate: { lte: new Date() } },
        ],
      },
      include: { sentimentGraph: { select: { id: true, generatedAt: true } } },
      orderBy: [
        { sentimentGraph: { generatedAt: 'asc' } },
        { createdAt: 'asc' },
      ],
      take: 200,
    })

    const now = new Date()
    const skipTally = {
      skipped_prerelease: 0,
      skipped_mature_stable: 0,
      skipped_already_regenerated_today: 0,
    }
    const eligibleTally = {
      eligible_no_graph: 0,
      eligible_recent_release: 0,
      eligible_thin_coverage: 0,
      eligible_stale_regen: 0,
    }

    const queueable: { id: string; title: string; reason: string }[] = []
    for (const film of candidates) {
      const decision: CronRegenDecision = decideCronRegen({
        releaseDate: film.releaseDate,
        qualityReviewCount: film.lastReviewCount,
        lastRegenAt: film.sentimentGraph?.generatedAt ?? null,
        now,
      })

      if (decision.skip) {
        skipTally[decision.reason]++
        continue
      }
      eligibleTally[decision.reason]++

      // Stop deep-checking once the per-run queue is full. Remaining eligible
      // films roll into the next cron tick.
      if (queueable.length >= MAX_FILMS_PER_BATCH) continue

      const { needsAnalysis, reason } = await filmNeedsReanalysis(film.id)
      if (!needsAnalysis) {
        skipTally.skipped_already_regenerated_today++
        continue
      }
      queueable.push({ id: film.id, title: film.title, reason })
      cronLogger.info({ filmId: film.id, filmTitle: film.title, reason }, 'Film queued for batch')
    }

    const eligibleTotal =
      eligibleTally.eligible_no_graph +
      eligibleTally.eligible_recent_release +
      eligibleTally.eligible_thin_coverage +
      eligibleTally.eligible_stale_regen

    cronLogger.info(
      {
        totalConsidered: candidates.length,
        skipped: skipTally,
        eligible: eligibleTally,
        eligibleTotal,
        queued: queueable.length,
        perRunCap: MAX_FILMS_PER_BATCH,
      },
      'Cron candidate decision summary'
    )

    if (queueable.length === 0) {
      cronLogger.info('No films need analysis')
      return Response.json({
        stage: 'no_work',
        message: 'No films need analysis',
        processed: 0,
        totalConsidered: candidates.length,
        skipped: skipTally,
        eligible: eligibleTally,
      })
    }

    // ── Stage C: prepare inputs (sequential, hash-skip + insufficient-reviews filtering) ──
    const readyInputs: SentimentGraphInput[] = []
    const skipResults: { title: string; status: string; reason: string }[] = []

    for (const candidate of queueable) {
      if (Date.now() > deadline - 60_000) {
        // Need >=60s to submit batch + at least one poll cycle. Stop preparing.
        cronLogger.info('Time budget tight — stopping prep before submission')
        break
      }

      const prep = await prepareSentimentGraphInput(candidate.id, { force: false })
      if (prep.status === 'ready') {
        readyInputs.push(prep.input)
      } else if (prep.status === 'skipped_unchanged') {
        skipResults.push({
          title: candidate.title,
          status: 'skipped_unchanged',
          reason: `hash match (${prep.reviewHash.slice(0, 12)}…)`,
        })
      } else if (prep.status === 'skipped_insufficient_reviews') {
        skipResults.push({
          title: candidate.title,
          status: 'skipped_insufficient_reviews',
          reason: `${prep.qualityCount} quality reviews, need ${prep.minRequired}`,
        })
      } else {
        skipResults.push({ title: candidate.title, status: 'skipped_film_not_found', reason: '' })
      }
    }

    if (readyInputs.length === 0) {
      cronLogger.info({ skipped: skipResults.length }, 'No films ready after prep stage')
      return Response.json({
        stage: 'no_work_after_prep',
        skipped: skipResults,
        durationMs: Date.now() - startTime,
      })
    }

    // ── Stage D: submit batch ──
    const submit = await analyzeSentimentBatch(
      readyInputs.map((input) => ({
        customId: input.film.id,
        system: input.promptParts.system,
        user: input.promptParts.user,
      }))
    )

    const jobs: PendingBatchJob[] = readyInputs.map((input) => ({
      filmId: input.film.id,
      reviewHash: input.reviewHash,
      filteredReviewCount: input.filteredReviewCount,
      sources: [...new Set(input.reviews.map((r) => r.sourcePlatform.toLowerCase()))],
    }))

    const state: PendingBatchState = {
      batchId: submit.batchId,
      submittedAt: submit.submittedAt,
      jobs,
    }
    await writePendingBatchState(state)

    cronLogger.info(
      {
        batchId: submit.batchId,
        jobCount: jobs.length,
        skipped: skipResults.length,
      },
      'Submitted new sentiment batch'
    )

    // ── Stage E: poll inline within remaining budget ──
    const results = await pollBatchUntilDone(submit.batchId, deadline, jobs)
    if (results === null) {
      // Will be picked up by the next cron run via the pending state
      return Response.json({
        stage: 'submitted_and_pending',
        batchId: submit.batchId,
        jobCount: jobs.length,
        skipped: skipResults,
        durationMs: Date.now() - startTime,
      })
    }

    const summary = await processBatchResults(results, jobs)
    await clearPendingBatchState()
    logCostSummary('inline_batch', summary.totals, summary.generated)
    if (summary.generated > 0) await invalidateHomepageCache()

    cronLogger.info(
      {
        stage: 'inline_batch_complete',
        generated: summary.generated,
        failed: summary.failed,
        skipped: skipResults.length,
        durationMs: Date.now() - startTime,
      },
      'Cron batch run complete'
    )

    return Response.json({
      stage: 'inline_batch_complete',
      batchId: submit.batchId,
      ...summary,
      estimatedUsd: Number(estimateSentimentCost(summary.totals, { isBatch: true }).toFixed(4)),
      skipped: skipResults,
      durationMs: Date.now() - startTime,
    })
  } catch (err) {
    cronLogger.error({ err, durationMs: Date.now() - startTime }, 'Cron route failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
