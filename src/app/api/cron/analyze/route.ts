import { prisma } from '@/lib/prisma'
import { generateSentimentGraph } from '@/lib/sentiment-pipeline'
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

    // Find films without graphs, or with graphs older than 30 days
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const filmsNeedingAnalysis = await prisma.film.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { sentimentGraph: null },
          { sentimentGraph: { generatedAt: { lt: thirtyDaysAgo } } },
        ],
      },
      take: 5,
      orderBy: { createdAt: 'asc' },
    })

    if (filmsNeedingAnalysis.length === 0) {
      cronLogger.info('No films need analysis')
      return Response.json({ message: 'No films need analysis', processed: 0 })
    }

    let succeeded = 0
    let failed = 0
    const results: { title: string; success: boolean; error?: string }[] = []

    for (const film of filmsNeedingAnalysis) {
      try {
        await generateSentimentGraph(film.id)
        results.push({ title: film.title, success: true })
        succeeded++
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        cronLogger.error({ filmId: film.id, filmTitle: film.title, error: message }, 'Film analysis failed in cron')
        results.push({
          title: film.title,
          success: false,
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
