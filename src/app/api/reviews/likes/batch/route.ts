import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

const PRIVATE_CACHE_HEADERS = { headers: { 'Cache-Control': 'private, no-store' } }

const MAX_IDS = 100

type LikeInfo = { count: number; liked: boolean }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null)
    const rawIds = body?.reviewIds

    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return NextResponse.json({}, PRIVATE_CACHE_HEADERS)
    }

    // Cap length; ignore ids beyond the limit and any non-string entries.
    const reviewIds = rawIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_IDS)

    if (reviewIds.length === 0) {
      return NextResponse.json({}, PRIVATE_CACHE_HEADERS)
    }

    // Logged-out viewers still see counts, so session may be absent (no 401).
    const session = await getMobileOrServerSession()

    const [grouped, likedRows] = await Promise.all([
      prisma.reviewLike.groupBy({
        by: ['reviewId'],
        where: { reviewId: { in: reviewIds } },
        _count: { reviewId: true },
      }),
      session?.user?.id
        ? prisma.reviewLike.findMany({
            where: { reviewId: { in: reviewIds }, userId: session.user.id },
            select: { reviewId: true },
          })
        : Promise.resolve([] as { reviewId: string }[]),
    ])

    const countByReview = new Map(grouped.map((g) => [g.reviewId, g._count.reviewId]))
    const likedByViewer = new Set(likedRows.map((r) => r.reviewId))

    // Every requested id is present, defaulting to { count: 0, liked: false }.
    const result: Record<string, LikeInfo> = {}
    for (const id of reviewIds) {
      result[id] = {
        count: countByReview.get(id) ?? 0,
        liked: likedByViewer.has(id),
      }
    }

    return NextResponse.json(result, PRIVATE_CACHE_HEADERS)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to load review like batch')
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
