import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getMobileOrServerSession: vi.fn(),
  prisma: {
    userReview: { findUnique: vi.fn() },
    reviewReply: { findUnique: vi.fn(), create: vi.fn() },
  },
  apiLogger: { error: vi.fn() },
  logActivity: vi.fn(),
}))

vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))
vi.mock('@/lib/activity', () => ({ logActivity: mocks.logActivity }))

const REPLIER_ID = 'u-replier'
const REVIEW_AUTHOR_ID = 'u-review-author'
const COMMENT_AUTHOR_ID = 'u-comment-author'
const REVIEW_ID = 'r-1'
const PARENT_ID = 'p-1'
const NEW_REPLY_ID = 'reply-new'

function postRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/reviews/${REVIEW_ID}/replies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function params() {
  return { params: Promise.resolve({ id: REVIEW_ID }) }
}

function parentRow(userId: string) {
  return { id: PARENT_ID, reviewId: REVIEW_ID, parentReplyId: null, userId }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: REPLIER_ID } })
  mocks.prisma.userReview.findUnique.mockResolvedValue({ id: REVIEW_ID, userId: REVIEW_AUTHOR_ID })
  mocks.prisma.reviewReply.findUnique.mockResolvedValue(parentRow(COMMENT_AUTHOR_ID))
  mocks.prisma.reviewReply.create.mockResolvedValue({
    id: NEW_REPLY_ID,
    body: 'Nice point',
    createdAt: new Date('2026-08-01T12:00:00Z'),
    parentReplyId: null,
    user: { id: REPLIER_ID, name: 'Replier', image: null },
  })
  mocks.logActivity.mockResolvedValue(undefined)
})

describe('POST /api/reviews/[id]/replies activity rows', () => {
  it('writes a reply row and a reply_to_comment row when replying to a comment', async () => {
    const { POST } = await import('@/app/api/reviews/[id]/replies/route')
    const res = await POST(postRequest({ body: 'Nice point', parentReplyId: PARENT_ID }), params())
    expect(res.status).toBe(201)

    expect(mocks.logActivity).toHaveBeenCalledTimes(2)
    expect(mocks.logActivity).toHaveBeenNthCalledWith(1, {
      actorId: REPLIER_ID,
      type: 'reply',
      targetUserId: REVIEW_AUTHOR_ID,
      reviewId: REVIEW_ID,
      replyId: NEW_REPLY_ID,
    })
    expect(mocks.logActivity).toHaveBeenNthCalledWith(2, {
      actorId: REPLIER_ID,
      type: 'reply_to_comment',
      targetUserId: COMMENT_AUTHOR_ID,
      reviewId: REVIEW_ID,
      replyId: NEW_REPLY_ID,
    })
  })

  it('writes exactly one row when the parent comment author is the review author', async () => {
    mocks.prisma.reviewReply.findUnique.mockResolvedValue(parentRow(REVIEW_AUTHOR_ID))
    const { POST } = await import('@/app/api/reviews/[id]/replies/route')
    const res = await POST(postRequest({ body: 'Nice point', parentReplyId: PARENT_ID }), params())
    expect(res.status).toBe(201)

    expect(mocks.logActivity).toHaveBeenCalledTimes(1)
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reply', targetUserId: REVIEW_AUTHOR_ID })
    )
  })

  it('writes only the review-author row when someone replies to their own comment', async () => {
    mocks.prisma.reviewReply.findUnique.mockResolvedValue(parentRow(REPLIER_ID))
    const { POST } = await import('@/app/api/reviews/[id]/replies/route')
    const res = await POST(postRequest({ body: 'Adding on', parentReplyId: PARENT_ID }), params())
    expect(res.status).toBe(201)

    expect(mocks.logActivity).toHaveBeenCalledTimes(1)
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reply', targetUserId: REVIEW_AUTHOR_ID })
    )
  })

  it('writes exactly one row and no reply_to_comment row for a top-level comment', async () => {
    const { POST } = await import('@/app/api/reviews/[id]/replies/route')
    const res = await POST(postRequest({ body: 'Great review' }), params())
    expect(res.status).toBe(201)

    expect(mocks.logActivity).toHaveBeenCalledTimes(1)
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reply', targetUserId: REVIEW_AUTHOR_ID })
    )
    expect(mocks.logActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reply_to_comment' })
    )
  })
})
