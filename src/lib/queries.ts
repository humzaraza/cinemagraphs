import { prisma } from './prisma'

/**
 * Shared query for the homepage "In Theaters" section.
 *
 * A film renders only if ALL of the following hold:
 *   1. nowPlayingOverride !== 'force_hide' (admin hard-exclude)
 *   2. nowPlayingOverride === 'force_show' OR nowPlaying === true
 *      (force_show bypasses the TMDB/region sync gate only)
 *   3. releaseDate is not null AND releaseDate <= now
 *      (pre-release films never render, even when force_show is set)
 *   4. SentimentGraph relation exists AND its dataPoints array is non-empty
 *      (we don't want to ship cards with a blank sparkline)
 *
 * Prisma 7's typed `where` can't express "JSON array length > 0" cleanly,
 * so we gate relation-existence at the DB level and do the non-empty array
 * check in application code. We over-fetch (`take: 40`) and `.slice(0, 20)`
 * after filtering so the final list hits the expected 20-row cap.
 */
export async function getInTheatersFilms() {
  const now = new Date()
  const films = await prisma.film.findMany({
    where: {
      status: 'ACTIVE',
      releaseDate: { not: null, lte: now },
      NOT: { nowPlayingOverride: 'force_hide' },
      OR: [
        { nowPlayingOverride: 'force_show' },
        { nowPlaying: true },
      ],
      sentimentGraph: { isNot: null },
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
