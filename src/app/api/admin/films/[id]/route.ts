import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { invalidateFilmCache, invalidateHomepageCache } from '@/lib/cache'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
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

    // Invalidate caches when homepage-affecting fields change
    const homepageFields = ['nowPlaying', 'isFeatured', 'pinnedSection', 'status']
    if (homepageFields.some((f) => f in updateData)) {
      await Promise.all([invalidateFilmCache(id), invalidateHomepageCache()])
    }

    return Response.json({ film })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to update film')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)

    if (!session?.user || session.user.role !== 'ADMIN') {
      return Response.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const { id } = await params

    // Verify film exists
    const film = await prisma.film.findUnique({ where: { id }, select: { id: true, title: true } })
    if (!film) {
      return Response.json({ error: 'Film not found' }, { status: 404 })
    }

    // Delete related records then the film (cascades handle most, but be explicit)
    await prisma.featuredFilm.deleteMany({ where: { filmId: id } })
    await prisma.sentimentGraph.deleteMany({ where: { filmId: id } })
    await prisma.review.deleteMany({ where: { filmId: id } })
    await prisma.film.delete({ where: { id } })

    return Response.json({ ok: true, title: film.title })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to delete film')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
