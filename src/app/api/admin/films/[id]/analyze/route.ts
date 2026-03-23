import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { generateSentimentGraph } from '@/lib/sentiment-pipeline'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const { id } = await params

  try {
    await generateSentimentGraph(id)
    return Response.json({ success: true, filmId: id })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed'
    return Response.json({ error: message }, { status: 500 })
  }
}
