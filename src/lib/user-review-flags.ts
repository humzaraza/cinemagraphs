import { prisma } from '@/lib/prisma'

/**
 * Film ids (out of `filmIds`) that `userId` has reviewed, from one batched
 * lookup. Matches the detail route's semantics: any UserReview row counts,
 * regardless of status.
 */
export async function getReviewedFilmIds(
  userId: string,
  filmIds: string[],
): Promise<Set<string>> {
  if (filmIds.length === 0) return new Set()
  const reviewed = await prisma.userReview.findMany({
    where: { userId, filmId: { in: filmIds } },
    select: { filmId: true },
  })
  return new Set(reviewed.map((r) => r.filmId))
}

/**
 * Attach `userHasReviewed` to each film. Returns a new array of new objects;
 * the inputs are never mutated. Callers hand this objects that came out of
 * cachedQuery, and the shared Redis payload must stay free of per-user data.
 */
export function attachUserHasReviewed<T extends { id: string }>(
  films: T[],
  reviewed: Set<string>,
): (T & { userHasReviewed: boolean })[] {
  return films.map((film) => ({ ...film, userHasReviewed: reviewed.has(film.id) }))
}
