// Accepts Date | string because Prisma returns Date but cache round-trips
// through JSON in Upstash Redis, so cached rows arrive as ISO strings.
export function withDerivedFields<T extends { releaseDate: Date | string | null }>(
  film: T,
): T & { year: number | null } {
  let year: number | null = null
  if (film.releaseDate) {
    const date = film.releaseDate instanceof Date ? film.releaseDate : new Date(film.releaseDate)
    const ts = date.getTime()
    if (!Number.isNaN(ts)) year = date.getFullYear()
  }
  return { ...film, year }
}
