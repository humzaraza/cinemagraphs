import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { generateSentimentGraph } from '@/lib/sentiment-pipeline'
import { apiLogger } from '@/lib/logger'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 403 })
  }

  const { id } = await params

  try {
    await generateSentimentGraph(id)
    return Response.json({ success: true, filmId: id })
  } catch (err) {
    apiLogger.error({ err, filmId: id }, 'Film analysis failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
