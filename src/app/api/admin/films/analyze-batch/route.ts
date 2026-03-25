import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { generateBatchSentimentGraphs } from '@/lib/sentiment-pipeline'

export const maxDuration = 300 // 5 minutes for Vercel

export async function POST(request: Request) {
  const session = await getServerSession(authOptions)
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
    const result = await generateBatchSentimentGraphs(filmIds)
    return Response.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Batch analysis failed'
    return Response.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
