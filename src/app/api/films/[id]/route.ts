import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
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
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch film')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
