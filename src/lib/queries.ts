import { prisma } from './prisma'

/**
 * Shared query for the homepage "In Theaters" section.
 *
 * A film qualifies via exactly one of two states (top-level OR):
 *   - nowPlayingOverride === 'force_show' (admin override — bypasses
 *     the TMDB/region sync gate but NOT release-date or sparkline)
 *   - nowPlayingOverride IS NULL AND nowPlaying === true (organic
 *     auto-managed inclusion)
 *
 * `force_hide` films are excluded by construction: they're neither
 * 'force_show' nor NULL.
 *
 * On top of either branch, ALL of these must also hold:
 *   - status === 'ACTIVE'
 *   - releaseDate IS NOT NULL AND releaseDate <= now (pre-release
 *     films never render, even when force_show is set)
 *   - SentimentGraph relation exists AND its dataPoints array is
 *     non-empty (no blank-sparkline cards)
 *
 * Why two distinct branches instead of "NOT force_hide AND
 * (force_show OR nowPlaying)": Prisma 7 / SQL three-valued logic
 * makes `NOT (col = 'X')` evaluate to UNKNOWN when col IS NULL,
 * which the WHERE clause rejects. Since 99%+ of films have
 * nowPlayingOverride = NULL, that earlier shape excluded the entire
 * candidate pool. Listing the qualifying states explicitly avoids
 * NOT entirely.
 *
 * Prisma 7's typed `where` can't express "JSON array length > 0"
 * cleanly, so we gate relation-existence at the DB level and do the
 * non-empty array check in application code. We over-fetch
 * (`take: 40`) and `.slice(0, 20)` after filtering so the final list
 * hits the expected 20-row cap.
 */
export async function getInTheatersFilms() {
  const now = new Date()
  const films = await prisma.film.findMany({
    where: {
      status: 'ACTIVE',
      releaseDate: { not: null, lte: now },
      sentimentGraph: { isNot: null },
      OR: [
        { nowPlayingOverride: 'force_show' },
        { nowPlayingOverride: null, nowPlaying: true },
      ],
    },
    include: { sentimentGraph: { select: { overallScore: true, dataPoints: true } } },
    take: 40,
    orderBy: { releaseDate: 'desc' },
  })
  return films
    .filter((f) => {
      const dp = f.sentimentGraph?.dataPoints
      return Array.isArray(dp) && dp.length > 0
    })
    .slice(0, 20)
}
