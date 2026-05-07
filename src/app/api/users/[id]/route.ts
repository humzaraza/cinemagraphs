import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { parseBackdropBannerValue } from '@/lib/banner-validation'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        username: true,
        image: true,
        bio: true,
        createdAt: true,
        isPublic: true,
        bannerType: true,
        bannerValue: true,
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

    // Compute follower/following counts
    const [followerCount, followingCount] = await Promise.all([
      prisma.follow.count({ where: { followingId: user.id } }),
      prisma.follow.count({ where: { followerId: user.id } }),
    ])

    // Get watchlist items
    const watchlistItems = await prisma.watchlist.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        film: {
          select: {
            id: true,
            title: true,
            posterUrl: true,
            releaseDate: true,
            genres: true,
            runtime: true,
            sentimentGraph: {
              select: { overallScore: true, dataPoints: true },
            },
          },
        },
      },
    })

    // Hydrate the BACKDROP fallback film: when bannerType is BACKDROP and
    // the parsed backdropPath is null (legacy / migrated rows), the renderer
    // needs the Film's default backdropUrl. Resolving server-side avoids a
    // second client round trip. Anything else (parse failure, non-BACKDROP)
    // returns null and the renderer falls back to a gradient.
    let bannerFilm: { backdropUrl: string | null } | null = null
    if (user.bannerType === 'BACKDROP') {
      const parsed = parseBackdropBannerValue(user.bannerValue)
      if (parsed.ok && parsed.value.backdropPath === null) {
        bannerFilm = await prisma.film.findUnique({
          where: { id: parsed.value.filmId },
          select: { backdropUrl: true },
        })
      }
    }

    // Derive a display name: name > username > 'User'
    const displayName = user.name || user.username || 'User'

    // Fetch public lists with preview posters
    const userLists = await prisma.list.findMany({
      where: { userId: user.id, isPublic: true },
      select: {
        id: true,
        name: true,
        genreTag: true,
        _count: { select: { films: true } },
        films: {
          take: 4,
          orderBy: { addedAt: 'asc' },
          select: {
            film: {
              select: { posterUrl: true },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    })

    return NextResponse.json({
      user: {
        id: user.id,
        name: displayName,
        rawName: user.name,
        username: user.username,
        image: user.image,
        bio: user.bio,
        createdAt: user.createdAt,
        followerCount,
        followingCount,
        bannerType: user.bannerType,
        bannerValue: user.bannerValue,
        bannerFilm,
      },
      stats: {
        totalReviews,
        avgRating,
        graphsContributed,
        filmsReacted: reactedFilmIds.size,
      },
      reviews: user.userReviews,
      reactions: user.liveReactions,
      watchlist: watchlistItems.map((w) => w.film),
      lists: userLists.map((l) => ({
        id: l.id,
        name: l.name,
        genreTag: l.genreTag,
        filmCount: l._count.films,
        previewPosters: l.films.map((lf) => lf.film.posterUrl),
      })),
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch user profile')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
