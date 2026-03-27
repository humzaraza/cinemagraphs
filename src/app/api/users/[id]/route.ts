import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      image: true,
      createdAt: true,
      isPublic: true,
      userReviews: {
        where: { status: 'approved' },
        orderBy: { createdAt: 'desc' },
        include: {
          film: {
            select: {
              id: true,
              title: true,
              posterUrl: true,
              releaseDate: true,
              director: true,
              runtime: true,
              sentimentGraph: {
                select: { overallScore: true, dataPoints: true },
              },
            },
          },
        },
      },
      liveReactions: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          filmId: true,
          reaction: true,
          score: true,
          sessionTimestamp: true,
          createdAt: true,
          film: {
            select: {
              id: true,
              title: true,
              posterUrl: true,
            },
          },
        },
      },
    },
  })

  if (!user || !user.isPublic) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Compute stats
  const totalReviews = user.userReviews.length
  const avgRating =
    totalReviews > 0
      ? Math.round(
          (user.userReviews.reduce((sum, r) => sum + r.overallRating, 0) / totalReviews) * 10
        ) / 10
      : 0
  const graphsContributed = user.userReviews.filter((r) => r.beatRatings !== null).length

  // Dedupe live reactions by film
  const reactedFilmIds = new Set(user.liveReactions.map((r) => r.filmId))

  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      image: user.image,
      createdAt: user.createdAt,
    },
    stats: {
      totalReviews,
      avgRating,
      graphsContributed,
      filmsReacted: reactedFilmIds.size,
    },
    reviews: user.userReviews,
    reactions: user.liveReactions,
  })
}
