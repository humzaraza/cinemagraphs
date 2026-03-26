import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)

  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 403 })
  }

  const { id } = await params
  const body = await request.json()

  const allowedFields = ['isFeatured', 'status', 'nowPlaying', 'pinnedSection'] as const
  const updateData: Record<string, unknown> = {}

  for (const field of allowedFields) {
    if (field in body) {
      updateData[field] = body[field]
    }
  }

  if (Object.keys(updateData).length === 0) {
    return Response.json({ error: 'No valid fields to update', code: 'BAD_REQUEST' }, { status: 400 })
  }

  const film = await prisma.film.update({
    where: { id },
    data: updateData,
  })

  return Response.json({ film })
}
