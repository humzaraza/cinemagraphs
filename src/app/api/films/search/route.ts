import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { withDerivedFields } from '@/lib/films'

interface SearchRow {
  id: string
  tmdbId: number
  imdbId: string | null
  title: string
  releaseDate: Date | null
  runtime: number | null
  synopsis: string | null
  posterUrl: string | null
  backdropUrl: string | null
  genres: string[]
  director: string | null
  cast: unknown
  imdbRating: number | null
  imdbVotes: number | null
  rtCriticsScore: number | null
  rtAudienceScore: number | null
  metacriticScore: number | null
  lastReviewCount: number
  nowPlaying: boolean
  nowPlayingOverride: string | null
  tickerOverride: string | null
  addedByUserId: string | null
  isFeatured: boolean
  pinnedSection: string | null
  status: string
  createdAt: Date
  updatedAt: Date
  graphOverallScore: number | null
}

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams.get('q')

    if (!query || query.trim().length === 0) {
      return Response.json({ error: 'Search query is required', code: 'BAD_REQUEST' }, { status: 400 })
    }

    const sanitizedQuery = query.trim().slice(0, 200)
    const rawLimit = Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10)
    const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20))

    let rows = await prisma.$queryRaw<SearchRow[]>`
      SELECT
        f."id", f."tmdbId", f."imdbId", f."title", f."releaseDate", f."runtime",
        f."synopsis", f."posterUrl", f."backdropUrl", f."genres", f."director",
        f."cast", f."imdbRating", f."imdbVotes", f."rtCriticsScore",
        f."rtAudienceScore", f."metacriticScore", f."lastReviewCount",
        f."nowPlaying", f."nowPlayingOverride", f."tickerOverride",
        f."addedByUserId", f."isFeatured", f."pinnedSection", f."status",
        f."createdAt", f."updatedAt",
        sg."overallScore" AS "graphOverallScore"
      FROM "Film" f
      LEFT JOIN "SentimentGraph" sg ON sg."filmId" = f."id"
      WHERE f."status" = 'ACTIVE'
        AND f."searchVector" @@ websearch_to_tsquery('english', ${sanitizedQuery})
      ORDER BY
        ts_rank_cd(f."searchVector", websearch_to_tsquery('english', ${sanitizedQuery})) DESC,
        (COALESCE(sg."overallScore", 0) * LN(GREATEST(f."lastReviewCount", 1) + 1)) DESC,
        f."title" ASC
      LIMIT ${limit}
    `

    if (rows.length === 0) {
      rows = await prisma.$queryRaw<SearchRow[]>`
        SELECT
          f."id", f."tmdbId", f."imdbId", f."title", f."releaseDate", f."runtime",
          f."synopsis", f."posterUrl", f."backdropUrl", f."genres", f."director",
          f."cast", f."imdbRating", f."imdbVotes", f."rtCriticsScore",
          f."rtAudienceScore", f."metacriticScore", f."lastReviewCount",
          f."nowPlaying", f."nowPlayingOverride", f."tickerOverride",
          f."addedByUserId", f."isFeatured", f."pinnedSection", f."status",
          f."createdAt", f."updatedAt",
          sg."overallScore" AS "graphOverallScore"
        FROM "Film" f
        LEFT JOIN "SentimentGraph" sg ON sg."filmId" = f."id"
        WHERE f."status" = 'ACTIVE'
          AND f."title" % ${sanitizedQuery}
        ORDER BY similarity(f."title", ${sanitizedQuery}) DESC, f."title" ASC
        LIMIT ${limit}
      `
    }

    const films = rows.map((row) => {
      const { graphOverallScore, ...film } = row
      return withDerivedFields({
        ...film,
        sentimentGraph: graphOverallScore !== null ? { overallScore: graphOverallScore } : null,
      })
    })

    return Response.json({ films, query: sanitizedQuery })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to search films')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
