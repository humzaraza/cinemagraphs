import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function PATCH(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { blindUnwatchedDefault, blindReviewedDefault, hasSeenBlindModeTooltip } = body as {
      blindUnwatchedDefault?: unknown
      blindReviewedDefault?: unknown
      hasSeenBlindModeTooltip?: unknown
    }

    const data: {
      blindUnwatchedDefault?: boolean
      blindReviewedDefault?: boolean
      hasSeenBlindModeTooltip?: boolean
    } = {}
    if (typeof blindUnwatchedDefault === 'boolean') {
      data.blindUnwatchedDefault = blindUnwatchedDefault
    }
    if (typeof blindReviewedDefault === 'boolean') {
      data.blindReviewedDefault = blindReviewedDefault
    }
    if (typeof hasSeenBlindModeTooltip === 'boolean') {
      data.hasSeenBlindModeTooltip = hasSeenBlindModeTooltip
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const updated = await prisma.user.update({
      where: { id: session.user.id },
      data,
      select: {
        blindUnwatchedDefault: true,
        blindReviewedDefault: true,
        hasSeenBlindModeTooltip: true,
      },
    })

    return NextResponse.json(updated)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to update blind-mode defaults')
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 },
    )
  }
}
