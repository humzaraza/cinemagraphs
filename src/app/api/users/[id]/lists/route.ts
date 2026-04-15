import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

// Public list index for a user's profile page.
// Visitors see only public lists; the owner (when authenticated) also sees private ones.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const session = await getMobileOrServerSession()
    const isOwner = session?.user?.id === id

    const lists = await prisma.list.findMany({
      where: {
        userId: id,
        ...(isOwner ? {} : { isPublic: true }),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        genreTag: true,
        isPublic: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { films: true } },
        films: {
          take: 5,
          orderBy: { addedAt: 'desc' },
          select: {
            film: { select: { id: true, posterUrl: true } },
          },
        },
      },
    })

    return NextResponse.json({
      lists: lists.map((l) => ({
        id: l.id,
        name: l.name,
        genreTag: l.genreTag,
        isPublic: l.isPublic,
        filmCount: l._count.films,
        previewPosters: l.films.map((f) => ({ id: f.film.id, posterUrl: f.film.posterUrl })),
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch user lists (public index)')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
