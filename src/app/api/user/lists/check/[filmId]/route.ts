import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filmId: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { filmId } = await params
    if (!filmId) {
      return NextResponse.json({ error: 'filmId is required' }, { status: 400 })
    }

    // Fetch all of the user's lists, and in the same query pull any ListFilm
    // rows that match this film. An empty films array means the film isn't in
    // the list; a populated one means it is.
    const lists = await prisma.list.findMany({
      where: { userId: session.user.id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        _count: { select: { films: true } },
        films: {
          where: { filmId },
          select: { id: true },
          take: 1,
        },
      },
    })

    return NextResponse.json({
      filmId,
      lists: lists.map((l) => ({
        listId: l.id,
        listName: l.name,
        filmCount: l._count.films,
        containsFilm: l.films.length > 0,
      })),
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to check film membership across lists')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
