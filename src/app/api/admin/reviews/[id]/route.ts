import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { invalidateFilmCache, invalidateHomepageCache } from '@/lib/cache'
import { logActivity } from '@/lib/activity'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json()
    const { status } = body

    if (!['approved', 'rejected'].includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }

    const prior =
      status === 'approved'
        ? await prisma.userReview.findUnique({
            where: { id },
            select: { status: true },
          })
        : null

    const review = await prisma.userReview.update({
      where: { id },
      data: {
        status,
        flagReason: status === 'approved' ? null : undefined,
      },
    })

    if (status === 'approved') {
      // Log a 'review' activity only on a real flagged->approved
      // transition, and only if creation-time logging (or a prior
      // approval) hasn't already produced a row for this review.
      if (prior?.status === 'flagged') {
        const existing = await prisma.activity.findFirst({
          where: { reviewId: review.id, type: 'review' },
          select: { id: true },
        })
        if (!existing) {
          await logActivity({
            actorId: review.userId,
            type: 'review',
            reviewId: review.id,
            filmId: review.filmId,
          })
        }
      }

      await Promise.all([
        invalidateFilmCache(review.filmId),
        invalidateHomepageCache(),
      ])
    }

    return NextResponse.json(review)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to update review status')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params

    await prisma.userReview.delete({ where: { id } })

    return NextResponse.json({ success: true })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to delete review')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
