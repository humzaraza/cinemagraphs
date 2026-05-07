/**
 * Pure TMDB URL construction helpers. No server-only imports here so
 * client components can import these without dragging in Prisma.
 *
 * src/lib/tmdb.ts is the server-side TMDB API wrapper (uses prisma,
 * cache, etc) and re-exports `getBackdropUrl` from here for callers
 * who want the helper from the same place as the rest of the TMDB
 * surface.
 */

/**
 * Construct a TMDB backdrop URL from a known file_path.
 *
 * Use this when you already have the TMDB-relative file_path (e.g.
 * from a cached backdrops projection or a stored banner reference).
 * For resolving a film's full backdrop list from a tmdbId, see
 * `getMovieBackdropUrls` in src/lib/tmdb.ts.
 *
 * The TMDB file_path always begins with '/'. We do not validate that
 * here; callers should have already.
 */
export function getBackdropUrl(filePath: string, size: string = 'w1280'): string {
  return `https://image.tmdb.org/t/p/${size}${filePath}`
}
