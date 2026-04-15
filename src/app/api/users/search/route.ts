import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl
    const q = searchParams.get('q')?.trim()
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)))

    if (!q) {
      return NextResponse.json({ error: 'Search query is required' }, { status: 400 })
    }

    const where = {
      isPublic: true,
      role: { not: 'BANNED' as const },
      OR: [
        { name: { contains: q, mode: 'insensitive' as const } },
        { username: { contains: q, mode: 'insensitive' as const } },
      ],
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          image: true,
          bio: true,
          _count: {
            select: {
              userReviews: true,
              followers: true,
              following: true,
            },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [
          { followers: { _count: 'desc' } },
          { userReviews: { _count: 'desc' } },
        ],
      }),
      prisma.user.count({ where }),
    ])

    const totalPages = Math.ceil(total / limit)

    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id,
        name: u.name || u.username || u.email.split('@')[0],
        username: u.username,
        image: u.image,
        bio: u.bio,
        reviewCount: u._count.userReviews,
        followerCount: u._count.followers,
        followingCount: u._count.following,
      })),
      total,
      page,
      totalPages,
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to search users')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
