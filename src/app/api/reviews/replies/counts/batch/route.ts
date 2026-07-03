import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

const MAX_IDS = 100

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null)
    const rawIds = body?.reviewIds

    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return NextResponse.json({})
    }

    // Cap length; ignore ids beyond the limit and any non-string entries.
    const reviewIds = rawIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_IDS)

    if (reviewIds.length === 0) {
      return NextResponse.json({})
    }

    // Public and user-agnostic: no session, no 401. The count includes
    // nested replies as well as top-level comments, which is the right
    // number for a card's "N replies" label (total thread activity).
    const grouped = await prisma.reviewReply.groupBy({
      by: ['reviewId'],
      where: { reviewId: { in: reviewIds } },
      _count: { reviewId: true },
    })

    const countByReview = new Map(grouped.map((g) => [g.reviewId, g._count.reviewId]))

    // Every requested id is present, defaulting to 0.
    const result: Record<string, number> = {}
    for (const id of reviewIds) {
      result[id] = countByReview.get(id) ?? 0
    }

    return NextResponse.json(result)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to load reply count batch')
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
