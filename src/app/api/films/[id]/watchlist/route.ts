import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ inWatchlist: false })
    }

    const { id } = await params
    const item = await prisma.watchlist.findUnique({
      where: { userId_filmId: { userId: session.user.id, filmId: id } },
    })

    return NextResponse.json({ inWatchlist: !!item })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to check watchlist status')
    return NextResponse.json({ inWatchlist: false })
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { id } = await params

    // Verify film exists
    const film = await prisma.film.findUnique({ where: { id }, select: { id: true } })
    if (!film) {
      return NextResponse.json({ error: 'Film not found' }, { status: 404 })
    }

    await prisma.watchlist.upsert({
      where: { userId_filmId: { userId: session.user.id, filmId: id } },
      create: { userId: session.user.id, filmId: id },
      update: {},
    })

    return NextResponse.json({ inWatchlist: true })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to add to watchlist')
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { id } = await params

    await prisma.watchlist.deleteMany({
      where: { userId: session.user.id, filmId: id },
    })

    return NextResponse.json({ inWatchlist: false })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to remove from watchlist')
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
