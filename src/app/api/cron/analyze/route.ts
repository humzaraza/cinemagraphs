import { prisma } from '@/lib/prisma'
import { generateSentimentGraph } from '@/lib/sentiment-pipeline'

export const maxDuration = 300

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
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
    return Response.json({ message: 'No films need analysis', processed: 0 })
  }

  const results: { title: string; success: boolean; error?: string }[] = []

  for (const film of filmsNeedingAnalysis) {
    try {
      await generateSentimentGraph(film.id)
      results.push({ title: film.title, success: true })
    } catch (err) {
      results.push({
        title: film.title,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  return Response.json({
    processed: results.length,
    results,
  })
}
