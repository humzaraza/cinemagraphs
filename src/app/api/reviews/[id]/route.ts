import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

const PRIVATE_CACHE_HEADERS = { headers: { 'Cache-Control': 'private, no-store' } }

// Not Redis-cached on purpose: review edits and deletes invalidate through
// invalidateFilmCache(filmId), which clears film-keyed entries only, so a
// review-keyed cache entry would serve stale data after an edit or a 200
// after a delete (same reasoning as src/lib/review-detail.ts). The response
// is per-viewer anyway because of `likes.liked`.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Public read: a missing session is fine, never a 401. The session only
    // personalizes `likes.liked` and lets the owner see their own
    // non-approved review.
    const session = await getMobileOrServerSession()
    const viewerId = session?.user?.id ?? null

    const { id: reviewId } = await params

    const review = await prisma.userReview.findUnique({
      where: { id: reviewId },
      select: {
        id: true,
        userId: true,
        filmId: true,
        overallRating: true,
        beginning: true,
        middle: true,
        ending: true,
        otherThoughts: true,
        combinedText: true,
        beatRatings: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, image: true } },
        film: {
          select: {
            id: true,
            title: true,
            posterUrl: true,
            releaseDate: true,
            director: true,
            runtime: true,
            sentimentGraph: { select: { dataPoints: true } },
          },
        },
      },
    })

    if (!review) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 })
    }

    // userId is fetched only for the ownership check; status is owner-only.
    const { userId: authorId, status, ...publicFields } = review
    const isOwner = viewerId !== null && authorId === viewerId

    // Visibility: approved reviews are public; flagged and rejected reviews
    // resolve only for their owner. This is deliberately stricter than the
    // web page at src/app/reviews/[id]/page.tsx, whose loader
    // (src/lib/review-detail.ts getReviewById) applies no status filter
    // because reviews currently go live as approved. A new JSON surface
    // should not extend that exposure to moderated content. The miss is a
    // 404 rather than a 403, with the same body as a missing id, so the
    // response does not reveal that a hidden review exists.
    if (status !== 'approved' && !isOwner) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 })
    }

    // Like state mirrors /api/reviews/likes/batch: count over all like rows,
    // liked from the viewer's own row (false when unauthenticated). The
    // reply count matches the `total` of GET /api/reviews/[id]/replies:
    // every row for the review, nested replies included.
    const [likeCount, viewerLike, replyCount] = await Promise.all([
      prisma.reviewLike.count({ where: { reviewId } }),
      viewerId
        ? prisma.reviewLike.findUnique({
            where: { userId_reviewId: { userId: viewerId, reviewId } },
            select: { id: true },
          })
        : Promise.resolve(null),
      prisma.reviewReply.count({ where: { reviewId } }),
    ])

    return NextResponse.json(
      {
        ...publicFields,
        ...(isOwner ? { status } : {}),
        likes: { count: likeCount, liked: viewerLike !== null },
        replyCount,
      },
      PRIVATE_CACHE_HEADERS
    )
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch review')
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
  } catch (err) {
    apiLogger.error({ err }, 'Failed to delete review')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
