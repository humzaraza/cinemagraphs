import { prisma } from './prisma'

/**
 * Shared query for "In Theaters" films.
 * Used by both the homepage and admin panel to ensure consistency.
 * Returns films where nowPlaying=true (which already accounts for overrides
 * since the admin PATCH and cron sync nowPlaying in tandem with nowPlayingOverride).
 */
export async function getInTheatersFilms() {
  return prisma.film.findMany({
    where: { status: 'ACTIVE', nowPlaying: true },
    include: { sentimentGraph: { select: { overallScore: true, dataPoints: true } } },
    take: 20,
    orderBy: { releaseDate: 'desc' },
  })
}
