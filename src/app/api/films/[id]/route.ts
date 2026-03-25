import { prisma } from '@/lib/prisma'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const film = await prisma.film.findUnique({
    where: { id },
    include: {
      sentimentGraph: true,
    },
  })

  if (!film) {
    return Response.json({ error: 'Film not found', code: 'NOT_FOUND' }, { status: 404 })
  }

  return Response.json(film)
}
