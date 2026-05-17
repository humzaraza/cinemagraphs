import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ filmId: string }> },
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { filmId } = await params
    if (!filmId || typeof filmId !== 'string') {
      return NextResponse.json({ error: 'filmId required' }, { status: 400 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof (body as { isBlind?: unknown }).isBlind !== 'boolean') {
      return NextResponse.json({ error: 'isBlind (boolean) required' }, { status: 400 })
    }
    const { isBlind } = body as { isBlind: boolean }

    const film = await prisma.film.findUnique({ where: { id: filmId }, select: { id: true } })
    if (!film) {
      return NextResponse.json({ error: 'Film not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    const override = await prisma.userFilmBlindMode.upsert({
      where: { userId_filmId: { userId: session.user.id, filmId } },
      create: { userId: session.user.id, filmId, isBlind },
      update: { isBlind },
      select: { filmId: true, isBlind: true, updatedAt: true },
    })

    return NextResponse.json(override)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to upsert per-film blind-mode override')
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 },
    )
  }
}
