import { NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET() {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    const events = await prisma.sentimentGraphDriftLog.findMany({
      where: { occurredAt: { gte: since } },
      orderBy: { occurredAt: 'desc' },
      take: 100,
      include: {
        film: { select: { id: true, title: true } },
      },
    })

    return NextResponse.json({
      events: events.map((event) => ({
        id: event.id,
        occurredAt: event.occurredAt.toISOString(),
        filmId: event.filmId,
        filmTitle: event.film?.title ?? null,
        callerPath: event.callerPath,
        existingBeatCount: event.existingBeatCount,
        incomingBeatCount: event.incomingBeatCount,
        action: event.action,
        mismatchedLabels: event.mismatchedLabels,
        envLockEnabled: event.envLockEnabled,
      })),
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch drift log')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
