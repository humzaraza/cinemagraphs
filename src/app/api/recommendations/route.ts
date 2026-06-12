import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import {
  MIN_REVIEWS,
  BASE_POOL,
  RESULT_LIMIT,
  seedWeight,
  scoreCandidates,
  preferredArcTags,
  applyArcBoost,
  applyQualityWeight,
} from '@/lib/recommendations'

// Every response from this route is per-user and must never enter a shared
// cache layer (CDN or browser shared cache). Same constant as /api/films,
// re-declared because it is module-private there.
const PRIVATE_CACHE_HEADERS = { headers: { 'Cache-Control': 'private, no-store' } }

export async function GET() {
  try {
    // Best-effort session, same pattern as /api/films: an auth-system failure
    // is treated as "no session" rather than a 500. Unlike the public list
    // routes, no session here means 401; there is nothing anonymous to serve.
    let userId: string | null = null
    try {
      const session = await getMobileOrServerSession()
      userId = session?.user?.id ?? null
    } catch {
      // Treated as unauthenticated below.
    }
    if (!userId) {
      return Response.json({ error: 'Authentication required' }, { status: 401 })
    }

    // One query doubles as the seed list and the exclusion set: every reviewed
    // film is excluded from candidates regardless of status or rating.
    const reviews = await prisma.userReview.findMany({
      where: { userId },
      select: {
        filmId: true,
        overallRating: true,
        film: { select: { sentimentGraph: { select: { arcShape: true } } } },
      },
    })

    if (reviews.length < MIN_REVIEWS) {
      return Response.json({ films: [] }, PRIVATE_CACHE_HEADERS)
    }

    const excluded = new Set(reviews.map((r) => r.filmId))
    const seeds = reviews.map((r) => ({ filmId: r.filmId, overallRating: r.overallRating }))
    const seedIds = seeds
      .filter((s) => seedWeight(s.overallRating) > 0)
      .map((s) => s.filmId)

    const edges =
      seedIds.length > 0
        ? await prisma.similarFilm.findMany({
            where: { filmId: { in: seedIds } },
            select: { filmId: true, similarFilmId: true, similarityScore: true },
          })
        : []

    // Base ranking, then keep a pool wide enough for the arc boost to reorder.
    // film id ascending breaks exact ties so the cut at BASE_POOL is
    // deterministic across requests.
    const totals = scoreCandidates(seeds, edges, excluded)
    const pool = [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, BASE_POOL)

    if (pool.length === 0) {
      return Response.json({ films: [] }, PRIVATE_CACHE_HEADERS)
    }

    // Hydrate the pool, mirroring the similar-films shape from films/[id]:
    // id, title, year, posterUrl, director, score.
    const films = await prisma.film.findMany({
      where: { id: { in: pool.map(([id]) => id) } },
      select: {
        id: true,
        title: true,
        releaseDate: true,
        posterUrl: true,
        director: true,
        sentimentGraph: { select: { overallScore: true, arcShape: true } },
      },
    })
    const filmsById = new Map(films.map((f) => [f.id, f]))

    const preferred = preferredArcTags(
      reviews.map((r) => ({
        filmId: r.filmId,
        overallRating: r.overallRating,
        arcShape: r.film.sentimentGraph?.arcShape ?? [],
      })),
    )

    const ranked: Array<{ film: (typeof films)[number]; weighted: number }> = []
    for (const [id, base] of pool) {
      const film = filmsById.get(id)
      if (!film) continue
      // A film without sentiment data cannot be recommended on a sentiment
      // platform: no quality signal means no rank.
      const sentimentScore = film.sentimentGraph?.overallScore
      if (sentimentScore == null) continue
      const boosted = applyArcBoost(base, film.sentimentGraph?.arcShape ?? [], preferred)
      ranked.push({ film, weighted: applyQualityWeight(boosted, sentimentScore) })
    }
    ranked.sort((a, b) => b.weighted - a.weighted || a.film.id.localeCompare(b.film.id))

    // Scores (base, similarity, boost, quality weight) are internals and stay out of the
    // response. userHasReviewed is false by construction: reviewed films were
    // excluded. The field exists for client shape consistency.
    return Response.json(
      {
        films: ranked.slice(0, RESULT_LIMIT).map(({ film }) => ({
          id: film.id,
          title: film.title,
          year: film.releaseDate ? film.releaseDate.getFullYear() : null,
          posterUrl: film.posterUrl,
          director: film.director,
          score: film.sentimentGraph?.overallScore ?? null,
          userHasReviewed: false,
        })),
      },
      PRIVATE_CACHE_HEADERS,
    )
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch recommendations')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
