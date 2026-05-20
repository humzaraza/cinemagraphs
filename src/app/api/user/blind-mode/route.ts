import { NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET() {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const userId = session.user.id

    const [user, overrides] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          blindUnwatchedDefault: true,
          hasSeenBlindModeTooltip: true,
        },
      }),
      prisma.userFilmBlindMode.findMany({
        where: { userId },
        select: { filmId: true, isBlind: true },
      }),
    ])

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const perFilm: Record<string, boolean> = {}
    for (const o of overrides) perFilm[o.filmId] = o.isBlind

    return NextResponse.json({
      blindUnwatchedDefault: user.blindUnwatchedDefault,
      perFilm,
      hasSeenBlindModeTooltip: user.hasSeenBlindModeTooltip,
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch blind-mode state')
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 },
    )
  }
}
