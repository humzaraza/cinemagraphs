import { prisma } from '@/lib/prisma'
import { generateSentimentGraph, filmNeedsReanalysis, fetchReviewsAndCheckThreshold } from '@/lib/sentiment-pipeline'
import { cronLogger } from '@/lib/logger'
import { invalidateFilmCache, invalidateHomepageCache } from '@/lib/cache'

export const maxDuration = 300

export async function GET(request: Request) {
  const startTime = Date.now()
  const TIME_BUDGET_MS = 280_000 // Leave 20s buffer before maxDuration

  try {
    // Verify cron secret
    const authHeader = request.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
    }

    // Get candidate films: prioritize no-graph films, then oldest graphs
    const candidates = await prisma.film.findMany({
      where: { status: 'ACTIVE' },
      include: { sentimentGraph: { select: { id: true, generatedAt: true } } },
      orderBy: [
        { sentimentGraph: { generatedAt: 'asc' } },
        { createdAt: 'asc' },
      ],
      take: 50, // Check more candidates since many may not meet threshold
    })

    // Filter to films that actually need re-analysis
    const filmsToProcess: { id: string; title: string; reason: string; hasGraph: boolean }[] = []

    for (const film of candidates) {
      if (filmsToProcess.length >= 10) break // Process max 10 per run

      const { needsAnalysis, reason } = await filmNeedsReanalysis(film.id)
      if (needsAnalysis) {
        filmsToProcess.push({
          id: film.id,
          title: film.title,
          reason,
          hasGraph: !!film.sentimentGraph,
        })
        cronLogger.info({ filmId: film.id, filmTitle: film.title, reason }, 'Film queued for analysis')
      }
    }

    if (filmsToProcess.length === 0) {
      cronLogger.info('No films need analysis')
      return Response.json({ message: 'No films need analysis', processed: 0 })
    }

    let succeeded = 0
    let failed = 0
    let skipped = 0
    const results: { title: string; status: 'generated' | 'skipped' | 'failed'; reason: string }[] = []

    for (let i = 0; i < filmsToProcess.length; i++) {
      const film = filmsToProcess[i]

      // Time budget check
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        cronLogger.info({ filmTitle: film.title }, 'Time budget exceeded, stopping')
        break
      }

      try {
        // For no-graph films, pre-check review threshold to avoid wasting API tokens
        if (!film.hasGraph) {
          const check = await fetchReviewsAndCheckThreshold(film.id)
          if (!check.meetsThreshold) {
            cronLogger.info({
              filmId: film.id, filmTitle: film.title,
              qualityCount: check.qualityCount, minRequired: check.minRequired,
            }, 'Skipped — insufficient reviews for new graph')
            results.push({
              title: film.title,
              status: 'skipped',
              reason: `${check.qualityCount} quality reviews, need ${check.minRequired}`,
            })
            skipped++
            continue
          }
        }

        await generateSentimentGraph(film.id)
        await invalidateFilmCache(film.id)
        results.push({ title: film.title, status: 'generated', reason: film.reason })
        succeeded++
      } catch (err) {
        cronLogger.error({ err, filmId: film.id, filmTitle: film.title }, 'Film analysis failed in cron')
        results.push({
          title: film.title,
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        })
        failed++
      }

      // Brief pause between films to avoid rate limits
      if (i < filmsToProcess.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }

    if (succeeded > 0) await invalidateHomepageCache()

    cronLogger.info({
      processed: results.length, succeeded, skipped, failed,
      durationMs: Date.now() - startTime,
    }, 'Cron analysis complete')

    return Response.json({
      processed: results.length,
      succeeded,
      skipped,
      failed,
      durationMs: Date.now() - startTime,
      results,
    })
  } catch (err) {
    cronLogger.error({ err, durationMs: Date.now() - startTime }, 'Cron route failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
