import { prisma } from '@/lib/prisma'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const graph = await prisma.sentimentGraph.findUnique({
    where: { filmId: id },
  })

  if (!graph) {
    return Response.json({ error: 'No sentiment graph found for this film' }, { status: 404 })
  }

  return Response.json({ graph })
}
