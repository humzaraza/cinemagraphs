import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

const PRIVATE_CACHE_HEADERS = { headers: { 'Cache-Control': 'private, no-store' } }

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ replyId: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { replyId } = await params

    const reply = await prisma.reviewReply.findUnique({
      where: { id: replyId },
      select: { userId: true },
    })
    if (!reply) {
      return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
    }

    if (reply.userId !== session.user.id) {
      return NextResponse.json({ error: 'You can only delete your own replies' }, { status: 403 })
    }

    // Deleting a top-level comment also deletes its child replies via the
    // ReplyThread self-relation's onDelete: Cascade. Intended.
    await prisma.reviewReply.delete({ where: { id: replyId } })

    return NextResponse.json({ success: true }, PRIVATE_CACHE_HEADERS)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to delete reply')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
