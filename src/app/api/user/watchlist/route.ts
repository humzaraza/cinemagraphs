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

    const items = await prisma.watchlist.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        film: {
          select: {
            id: true,
            title: true,
            posterUrl: true,
            releaseDate: true,
            genres: true,
          },
        },
      },
    })

    return NextResponse.json({
      films: items.map((w) => ({
        id: w.film.id,
        title: w.film.title,
        posterUrl: w.film.posterUrl,
        year: w.film.releaseDate ? new Date(w.film.releaseDate).getFullYear() : null,
        genres: w.film.genres,
      })),
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch user watchlist')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { filmId } = await request.json()
    if (!filmId || typeof filmId !== 'string') {
      return NextResponse.json({ error: 'filmId is required' }, { status: 400 })
    }

    await prisma.watchlist.upsert({
      where: { userId_filmId: { userId: session.user.id, filmId } },
      create: { userId: session.user.id, filmId },
      update: {},
    })

    return NextResponse.json({ message: 'Added to watchlist' })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to add to watchlist')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { filmId } = await request.json()
    if (!filmId || typeof filmId !== 'string') {
      return NextResponse.json({ error: 'filmId is required' }, { status: 400 })
    }

    await prisma.watchlist.deleteMany({
      where: { userId: session.user.id, filmId },
    })

    return NextResponse.json({ message: 'Removed from watchlist' })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to remove from watchlist')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
