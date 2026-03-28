import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { cacheGet, cacheSet, KEYS } from '@/lib/cache'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const cached = await cacheGet(KEYS.graph(id))
    if (cached) return Response.json(cached)

    const graph = await prisma.sentimentGraph.findUnique({
      where: { filmId: id },
    })

    if (!graph) {
      return Response.json({ error: 'No sentiment graph found for this film', code: 'NOT_FOUND' }, { status: 404 })
    }

    const payload = { graph }
    await cacheSet(KEYS.graph(id), payload)

    return Response.json(payload)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch sentiment graph')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
