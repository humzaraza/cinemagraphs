import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { searchParams } = request.nextUrl
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)))

    // Verify user exists
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const session = await getMobileOrServerSession()
    const currentUserId = session?.user?.id ?? null

    const [follows, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followingId: id },
        select: {
          follower: {
            select: {
              id: true,
              name: true,
              username: true,
              email: true,
              image: true,
            },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.follow.count({ where: { followingId: id } }),
    ])

    // Check which of these followers the current user follows
    let followingSet = new Set<string>()
    if (currentUserId) {
      const followerIds = follows.map((f) => f.follower.id)
      if (followerIds.length > 0) {
        const myFollows = await prisma.follow.findMany({
          where: {
            followerId: currentUserId,
            followingId: { in: followerIds },
          },
          select: { followingId: true },
        })
        followingSet = new Set(myFollows.map((f) => f.followingId))
      }
    }

    const totalPages = Math.ceil(total / limit)

    return NextResponse.json({
      users: follows.map((f) => ({
        id: f.follower.id,
        name: f.follower.name || f.follower.username || f.follower.email.split('@')[0],
        username: f.follower.username,
        image: f.follower.image,
        isFollowing: followingSet.has(f.follower.id),
      })),
      total,
      page,
      totalPages,
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch followers')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
