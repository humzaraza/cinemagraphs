import { NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function POST() {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    await prisma.user.update({
      where: { id: session.user.id },
      data: { lastSeenActivityAt: new Date() },
      select: { id: true },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to mark activity as seen')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
