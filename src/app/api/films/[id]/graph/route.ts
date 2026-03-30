import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { cachedQuery, KEYS, TTL } from '@/lib/cache'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const payload = await cachedQuery(KEYS.graph(id), TTL.GRAPH, async () => {
      const graph = await prisma.sentimentGraph.findUnique({
        where: { filmId: id },
      })
      return graph ? { graph } : null
    })

    if (!payload) {
      return Response.json({ error: 'No sentiment graph found for this film', code: 'NOT_FOUND' }, { status: 404 })
    }

    return Response.json(payload)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch sentiment graph')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
