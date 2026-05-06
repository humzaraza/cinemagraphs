import { prisma } from './prisma'
import type { SentimentDataPoint } from './types'

const RECENT_REVIEWS_LIMIT = 5
const LISTS_LIMIT = 3
const MOSAIC_POSTERS_TARGET = 4

/**
 * Per-user sparkline derivation. Walks the canonical film timeline
 * (sentimentGraph.dataPoints, in beat order) and overlays the user's
 * per-beat scores from UserReview.beatRatings, keyed by beat label.
 * For any beat the user did not rate, the canonical score fills in.
 *
 * Returns a flat number[] of length = number of beats, values 0..10.
 *
 * Returns [] when the film has no canonical timeline (no
 * sentimentGraph) or when the review carries no beatRatings at all.
 * The partial-rating fallback (canonical score for un-rated beats) is
 * intentional for PR 1a. A richer hybrid signal (live-reaction
 * blending, per-user interpolation) is parked as a followup.
 */
export function userSparklinePoints(
  dataPoints: SentimentDataPoint[] | null | undefined,
  beatRatings: unknown
): number[] {
  if (!dataPoints || dataPoints.length === 0) return []
  if (!beatRatings || typeof beatRatings !== 'object') return []
  const ratings = beatRatings as Record<string, unknown>
  return dataPoints.map((dp) => {
    const userScore = ratings[dp.label]
    return typeof userScore === 'number' ? userScore : dp.score
  })
}

function yearOf(releaseDate: Date | null | undefined): number | null {
  if (!releaseDate) return null
  return releaseDate.getFullYear()
}

function buildMosaicPosters(posters: string[]): string[] {
  if (posters.length === 0) return []
  if (posters.length >= MOSAIC_POSTERS_TARGET) return posters.slice(0, MOSAIC_POSTERS_TARGET)
  if (posters.length === 1) return [posters[0], posters[0], posters[0], posters[0]]
  return [posters[0], posters[1], posters[0], posters[1]]
}

async function hydrateFavoriteFilms(userId: string, ids: string[]) {
  if (ids.length === 0) return []
  const [films, reviews] = await Promise.all([
    prisma.film.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        title: true,
        releaseDate: true,
        posterUrl: true,
        sentimentGraph: { select: { dataPoints: true } },
      },
    }),
    prisma.userReview.findMany({
      where: { userId, filmId: { in: ids } },
      select: { filmId: true, beatRatings: true },
    }),
  ])
  const filmById = new Map(films.map((f) => [f.id, f]))
  const reviewByFilmId = new Map(reviews.map((r) => [r.filmId, r]))

  return ids.flatMap((id) => {
    const f = filmById.get(id)
    if (!f) return []
    const review = reviewByFilmId.get(id)
    const dataPoints = (f.sentimentGraph?.dataPoints ?? null) as SentimentDataPoint[] | null
    return [{
      id: f.id,
      title: f.title,
      year: yearOf(f.releaseDate),
      posterUrl: f.posterUrl,
      sparklinePoints: review ? userSparklinePoints(dataPoints, review.beatRatings) : [],
    }]
  })
}

export async function buildProfileResponse(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      username: true,
      bio: true,
      image: true,
      email: true,
      role: true,
      createdAt: true,
      bannerType: true,
      bannerValue: true,
      favoriteFilms: true,
      _count: {
        select: {
          userReviews: true,
          watchlistItems: true,
          lists: true,
          following: true,
          followers: true,
        },
      },
    },
  })

  if (!user) return null

  const [favoriteFilms, recentReviewsRaw, listsRaw] = await Promise.all([
    hydrateFavoriteFilms(user.id, user.favoriteFilms),
    prisma.userReview.findMany({
      where: { userId: user.id, status: 'approved' },
      orderBy: { createdAt: 'desc' },
      take: RECENT_REVIEWS_LIMIT,
      select: {
        overallRating: true,
        beatRatings: true,
        film: {
          select: {
            id: true,
            title: true,
            releaseDate: true,
            director: true,
            posterUrl: true,
            backdropUrl: true,
            sentimentGraph: { select: { dataPoints: true } },
          },
        },
      },
    }),
    prisma.list.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: LISTS_LIMIT,
      select: {
        id: true,
        name: true,
        _count: { select: { films: true } },
        films: {
          take: MOSAIC_POSTERS_TARGET,
          orderBy: { addedAt: 'asc' },
          select: { film: { select: { posterUrl: true } } },
        },
      },
    }),
  ])

  const recentReviews = recentReviewsRaw.map((r) => {
    const dataPoints = (r.film.sentimentGraph?.dataPoints ?? null) as SentimentDataPoint[] | null
    return {
      filmId: r.film.id,
      title: r.film.title,
      year: yearOf(r.film.releaseDate),
      director: r.film.director,
      posterUrl: r.film.posterUrl,
      backdropUrl: r.film.backdropUrl,
      score: r.overallRating,
      sparklinePoints: userSparklinePoints(dataPoints, r.beatRatings),
    }
  })

  const lists = listsRaw.map((l) => ({
    id: l.id,
    name: l.name,
    filmCount: l._count.films,
    mosaicPosters: buildMosaicPosters(
      l.films.map((lf) => lf.film.posterUrl).filter((p): p is string => p != null)
    ),
  }))

  return {
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      bio: user.bio,
      image: user.image,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      bannerType: user.bannerType,
      bannerValue: user.bannerValue,
      favoriteFilms,
    },
    stats: {
      reviewCount: user._count.userReviews,
      watchedCount: user._count.userReviews,
      watchlistCount: user._count.watchlistItems,
      listCount: user._count.lists,
      followingCount: user._count.following,
      followerCount: user._count.followers,
    },
    recentReviews,
    lists,
  }
}
