import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { logActivity } from '@/lib/activity'

const PRIVATE_CACHE_HEADERS = { headers: { 'Cache-Control': 'private, no-store' } }

const MAX_REPLY_LENGTH = 2000

const replySelect = {
  id: true,
  body: true,
  createdAt: true,
  parentReplyId: true,
  user: { select: { id: true, name: true, image: true } },
} as const

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { id: reviewId } = await params

    const payload = await request.json().catch(() => null)
    if (!payload || typeof payload !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const { body, parentReplyId } = payload as { body?: unknown; parentReplyId?: unknown }

    const trimmed = typeof body === 'string' ? body.trim() : ''
    if (trimmed.length === 0) {
      return NextResponse.json({ error: 'Reply text is required' }, { status: 400 })
    }
    if (trimmed.length > MAX_REPLY_LENGTH) {
      return NextResponse.json(
        { error: `Replies are limited to ${MAX_REPLY_LENGTH} characters` },
        { status: 400 }
      )
    }
    if (parentReplyId !== undefined && parentReplyId !== null && typeof parentReplyId !== 'string') {
      return NextResponse.json({ error: 'Invalid parent reply id' }, { status: 400 })
    }

    const review = await prisma.userReview.findUnique({
      where: { id: reviewId },
      select: { id: true, userId: true },
    })
    if (!review) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 })
    }

    // Two-level depth guard. The schema's self-relation places no limit on
    // nesting, so the rule (a comment can have replies; a reply cannot) is
    // enforced here: replying to anything that itself has a parent is
    // rejected, and the parent must belong to this review.
    if (typeof parentReplyId === 'string') {
      const parent = await prisma.reviewReply.findUnique({
        where: { id: parentReplyId },
        select: { id: true, reviewId: true, parentReplyId: true },
      })
      if (!parent) {
        return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
      }
      if (parent.reviewId !== reviewId) {
        return NextResponse.json(
          { error: 'Parent comment belongs to a different review' },
          { status: 400 }
        )
      }
      if (parent.parentReplyId !== null) {
        return NextResponse.json(
          { error: 'Replies cannot be nested more than one level' },
          { status: 403 }
        )
      }
    }

    const reply = await prisma.reviewReply.create({
      data: {
        reviewId,
        userId: session.user.id,
        body: trimmed,
        parentReplyId: typeof parentReplyId === 'string' ? parentReplyId : null,
      },
      select: replySelect,
    })

    await logActivity({
      actorId: session.user.id,
      type: 'reply',
      targetUserId: review.userId,
      reviewId,
      replyId: reply.id,
    })

    return NextResponse.json(reply, { status: 201, ...PRIVATE_CACHE_HEADERS })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to create reply')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: reviewId } = await params

    // Public read: logged-out viewers can see the thread. Kept as a plain
    // dynamic read (no cachedQuery) because replies change often and no
    // invalidation path exists for a reply-keyed cache entry.
    const replies = await prisma.reviewReply.findMany({
      where: { reviewId },
      orderBy: { createdAt: 'asc' },
      select: replySelect,
    })

    // Pre-group into the two-level shape the client renders directly:
    // top-level comments (parentReplyId null) each with their children,
    // both levels already sorted createdAt asc by the query above.
    const comments = replies
      .filter((r) => r.parentReplyId === null)
      .map((comment) => ({
        ...comment,
        children: replies.filter((r) => r.parentReplyId === comment.id),
      }))

    return NextResponse.json({ comments, total: replies.length })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch replies')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
