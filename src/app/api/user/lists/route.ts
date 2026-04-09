import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET() {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const lists = await prisma.list.findMany({
      where: { userId: session.user.id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        genreTag: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { films: true } },
        films: {
          take: 3,
          orderBy: { addedAt: 'desc' },
          select: {
            film: {
              select: { posterUrl: true },
            },
          },
        },
      },
    })

    return NextResponse.json({
      lists: lists.map((l) => ({
        id: l.id,
        name: l.name,
        genreTag: l.genreTag,
        filmCount: l._count.films,
        previewPosters: l.films.map((f) => f.film.posterUrl),
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch user lists')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const body = await request.json()
    const { name, genreTag, filmIds } = body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'List name is required' }, { status: 400 })
    }

    const list = await prisma.list.create({
      data: {
        name: name.trim(),
        genreTag: genreTag || null,
        userId: session.user.id,
        films: filmIds?.length
          ? {
              create: filmIds.map((filmId: string) => ({ filmId })),
            }
          : undefined,
      },
      select: {
        id: true,
        name: true,
        genreTag: true,
        createdAt: true,
        _count: { select: { films: true } },
      },
    })

    return NextResponse.json(list, { status: 201 })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to create list')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
