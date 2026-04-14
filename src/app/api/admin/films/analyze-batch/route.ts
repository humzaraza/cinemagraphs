import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { generateBatchSentimentGraphs } from '@/lib/sentiment-pipeline'
import { apiLogger } from '@/lib/logger'

export const maxDuration = 300 // 5 minutes for Vercel

export async function POST(request: Request) {
  const session = await getMobileOrServerSession()
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 403 })
  }

  const body = await request.json()
  const { filmIds } = body

  if (!Array.isArray(filmIds) || filmIds.length === 0) {
    return Response.json({ error: 'filmIds must be a non-empty array', code: 'BAD_REQUEST' }, { status: 400 })
  }

  if (filmIds.length > 20) {
    return Response.json({ error: 'Maximum 20 films per batch', code: 'BAD_REQUEST' }, { status: 400 })
  }

  // Validate all IDs are strings
  if (!filmIds.every((id: unknown) => typeof id === 'string')) {
    return Response.json({ error: 'All filmIds must be strings', code: 'BAD_REQUEST' }, { status: 400 })
  }

  try {
    // Admin batch "Analyze" is an explicit force-regenerate request.
    const result = await generateBatchSentimentGraphs(filmIds, { force: true })
    return Response.json(result)
  } catch (err) {
    apiLogger.error({ err, filmIds }, 'Batch analysis failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
