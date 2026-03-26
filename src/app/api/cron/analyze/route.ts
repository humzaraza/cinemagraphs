import { prisma } from '@/lib/prisma'
import { generateSentimentGraph, filmNeedsReanalysis } from '@/lib/sentiment-pipeline'
import { cronLogger } from '@/lib/logger'

export const maxDuration = 300

export async function GET(request: Request) {
  const startTime = Date.now()

  try {
    // Verify cron secret
    const authHeader = request.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
    }

    // Get candidate films: no graph, or any active film (we'll check threshold)
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
    const filmsToProcess: { id: string; title: string; reason: string }[] = []

    for (const film of candidates) {
      if (filmsToProcess.length >= 10) break // Process max 10 per run

      const { needsAnalysis, reason } = await filmNeedsReanalysis(film.id)
      if (needsAnalysis) {
        filmsToProcess.push({ id: film.id, title: film.title, reason })
        cronLogger.info({ filmId: film.id, filmTitle: film.title, reason }, 'Film queued for analysis')
      }
    }

    if (filmsToProcess.length === 0) {
      cronLogger.info('No films need analysis')
      return Response.json({ message: 'No films need analysis', processed: 0 })
    }

    let succeeded = 0
    let failed = 0
    const results: { title: string; success: boolean; reason: string; error?: string }[] = []

    for (const film of filmsToProcess) {
      try {
        await generateSentimentGraph(film.id)
        results.push({ title: film.title, success: true, reason: film.reason })
        succeeded++
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        cronLogger.error({ filmId: film.id, filmTitle: film.title, error: message }, 'Film analysis failed in cron')
        results.push({
          title: film.title,
          success: false,
          reason: film.reason,
          error: message,
        })
        failed++
      }
    }

    cronLogger.info({ processed: results.length, succeeded, failed, durationMs: Date.now() - startTime }, 'Cron analysis complete')

    return Response.json({
      processed: results.length,
      succeeded,
      failed,
      durationMs: Date.now() - startTime,
      results,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    cronLogger.error({ error: message, durationMs: Date.now() - startTime }, 'Cron route failed')
    return Response.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
