import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { logActivity } from '@/lib/activity'

const PRIVATE_CACHE_HEADERS = { headers: { 'Cache-Control': 'private, no-store' } }

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { id: reviewId } = await params

    const review = await prisma.userReview.findUnique({
      where: { id: reviewId },
      select: { userId: true },
    })

    if (!review) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 })
    }

    // Server enforcement of the no-self-like rule. The UI hiding the button is
    // not sufficient on its own.
    if (review.userId === session.user.id) {
      return NextResponse.json({ error: 'You cannot like your own review' }, { status: 403 })
    }

    // Idempotent: re-liking an already-liked review is a no-op (unique
    // violation) and logs no activity.
    try {
      await prisma.reviewLike.create({
        data: { userId: session.user.id, reviewId },
      })
      await logActivity({ actorId: session.user.id, type: 'like', targetUserId: review.userId, reviewId })
    } catch (err: any) {
      if (err.code !== 'P2002') throw err
    }

    const count = await prisma.reviewLike.count({ where: { reviewId } })

    return NextResponse.json({ liked: true, count }, PRIVATE_CACHE_HEADERS)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to like review')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
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

    const { id: reviewId } = await params

    // Deleting a like you do not have is a harmless no-op, so no ownership check.
    await prisma.reviewLike.deleteMany({
      where: { userId: session.user.id, reviewId },
    })

    const count = await prisma.reviewLike.count({ where: { reviewId } })

    return NextResponse.json({ liked: false, count }, PRIVATE_CACHE_HEADERS)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to unlike review')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
