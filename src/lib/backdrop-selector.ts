/**
 * Shared TMDB backdrop selection helpers.
 *
 * The quality filter and sort order are the canonical "is this a usable
 * banner backdrop" rules, mirrored from the original implementation in
 * src/app/api/films/[id]/backdrops/route.ts:
 *
 *   filter: width >= 1280 (drop thumbnails / odd small uploads)
 *           iso_639_1 === null (clean cinematography stills, no text or
 *           title cards in any language)
 *   sort:   vote_count DESC, vote_average DESC as tiebreaker. Volume
 *           before rating prevents single-vote outliers ranking above
 *           well-voted backdrops.
 *
 * Two helpers:
 *   - getQualityBackdrops: full filtered + sorted set (no slice, no
 *     projection). The /api/films/[id]/backdrops route slices to 20
 *     and projects to a 5-field shape on top of this.
 *   - pickBestBackdrop: top file_path or null. Best-effort: returns
 *     null on any TMDB failure so cascade callers don't 500.
 */
import { getMovieImages } from './tmdb'

const MIN_BACKDROP_WIDTH = 1280

export type QualityBackdrop = {
  file_path: string
  width: number
  height: number
  vote_average: number
  vote_count: number
  iso_639_1: string | null
}

export async function getQualityBackdrops(tmdbId: number): Promise<QualityBackdrop[]> {
  const images = await getMovieImages(tmdbId)
  if (!images?.backdrops) return []
  return images.backdrops
    .filter((b) => b.width >= MIN_BACKDROP_WIDTH && b.iso_639_1 === null)
    .sort((a, b) => b.vote_count - a.vote_count || b.vote_average - a.vote_average)
}

export async function pickBestBackdrop(tmdbId: number): Promise<string | null> {
  try {
    const qualifying = await getQualityBackdrops(tmdbId)
    return qualifying[0]?.file_path ?? null
  } catch {
    return null
  }
}
