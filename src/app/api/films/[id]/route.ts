import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { cachedQuery, KEYS, TTL } from '@/lib/cache'
import { withDerivedFields } from '@/lib/films'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { DEFAULT_TOP_N } from '@/lib/similar-films'

const DEFAULT_SIMILAR_LIMIT = 8
const MAX_SIMILAR_LIMIT = DEFAULT_TOP_N

interface SimilarFilmHydrated {
  id: string
  title: string
  year: number | null
  posterUrl: string | null
  director: string | null
  score: number | null
  similarityScore: number
  userHasReviewed: boolean
  matchSignals?: object
}

function parseSimilarLimit(raw: string | null): number {
  if (!raw) return DEFAULT_SIMILAR_LIMIT
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SIMILAR_LIMIT
  return Math.min(n, MAX_SIMILAR_LIMIT)
}

async function loadSimilarFilms(filmId: string) {
  return cachedQuery(KEYS.filmSimilar(filmId), TTL.FILM, async () => {
    const rows = await prisma.similarFilm.findMany({
      where: { filmId },
      orderBy: { similarityScore: 'desc' },
      take: MAX_SIMILAR_LIMIT,
      include: {
        similar: {
          select: {
            id: true,
            title: true,
            releaseDate: true,
            posterUrl: true,
            director: true,
            sentimentGraph: { select: { overallScore: true } },
          },
        },
      },
    })
    return rows.map((row) => {
      const yearDate = row.similar.releaseDate
        ? row.similar.releaseDate instanceof Date
          ? row.similar.releaseDate
          : new Date(row.similar.releaseDate)
        : null
      const year =
        yearDate && !Number.isNaN(yearDate.getTime()) ? yearDate.getFullYear() : null
      return {
        id: row.similar.id,
        title: row.similar.title,
        year,
        posterUrl: row.similar.posterUrl,
        director: row.similar.director,
        score: row.similar.sentimentGraph?.overallScore ?? null,
        similarityScore: row.similarityScore,
        matchSignals: row.matchSignals as object,
      }
    })
  })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const url = new URL(request.url)
    const similarLimit = parseSimilarLimit(url.searchParams.get('similar'))

    const film = await cachedQuery(KEYS.film(id), TTL.FILM, () =>
      prisma.film.findUnique({
        where: { id },
        include: { sentimentGraph: true, filmBeats: true },
      })
    )

    if (!film) {
      return Response.json({ error: 'Film not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    const cached = await loadSimilarFilms(id)
    const top = cached.slice(0, similarLimit)

    // Session is best-effort: unauthenticated requests still get a valid response.
    let userId: string | null = null
    let isAdmin = false
    try {
      const session = await getMobileOrServerSession()
      userId = session?.user?.id ?? null
      isAdmin = session?.user?.role === 'ADMIN'
    } catch {
      // Auth failure on a public endpoint is non-fatal.
    }

    let reviewedSet: Set<string> = new Set()
    if (userId) {
      const reviewed = await prisma.userReview.findMany({
        where: { userId, filmId: { in: [id, ...top.map((t) => t.id)] } },
        select: { filmId: true },
      })
      reviewedSet = new Set(reviewed.map((r) => r.filmId))
    }

    const exposeSignals = isAdmin || process.env.NODE_ENV !== 'production'

    const similarFilms: SimilarFilmHydrated[] = top.map((t) => {
      const out: SimilarFilmHydrated = {
        id: t.id,
        title: t.title,
        year: t.year,
        posterUrl: t.posterUrl,
        director: t.director,
        score: t.score,
        similarityScore: t.similarityScore,
        userHasReviewed: reviewedSet.has(t.id),
      }
      if (exposeSignals) out.matchSignals = t.matchSignals
      return out
    })

    return Response.json({
      ...withDerivedFields(film),
      userHasReviewed: reviewedSet.has(id),
      similarFilms,
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch film')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
