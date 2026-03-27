import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const graph = await prisma.sentimentGraph.findUnique({
      where: { filmId: id },
    })

    if (!graph) {
      return Response.json({ error: 'No sentiment graph found for this film', code: 'NOT_FOUND' }, { status: 404 })
    }

    return Response.json({ graph })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch sentiment graph')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
