import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)
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

  if (review.userId !== session.user.id) {
    return NextResponse.json({ error: 'You can only delete your own reviews' }, { status: 403 })
  }

  await prisma.userReview.delete({ where: { id: reviewId } })

  return NextResponse.json({ success: true })
}
