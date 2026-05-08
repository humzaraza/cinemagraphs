/**
 * POST /api/onboarding/select-banner
 *
 * Locked policy: pick a banner for a new mobile user based on their
 * onboarding selections, cascading through three film sources before
 * giving up to a gradient.
 *
 *   1. SCREEN 3 PASS  Top-rated film among the user's Screen 3 picks
 *                     that has at least one quality TMDB backdrop.
 *   2. GENRE PASS     Top-rated curated film from any selected genre
 *                     block with a quality backdrop.
 *   3. ERA PASS       Top-rated curated film from any selected era
 *                     block with a quality backdrop.
 *   4. GRADIENT       'midnight' fallback (skip-everything path only).
 *
 * Top-rated sort: imdbRating DESC, imdbVotes DESC tiebreaker, title ASC
 * final tiebreaker (nulls last on the score columns). Both score fields
 * exist on Film; this matches the user's intent to prefer rating where
 * present and fall back to votes where rating is null.
 *
 * Quality-backdrop check: pickBestBackdrop in @/lib/backdrop-selector
 * applies the same width >= 1280 + iso_639_1 === null filter the
 * /api/films/[id]/backdrops route uses, then takes the top-voted item.
 *
 * Request:
 *   { filmIds?: string[], genres?: string[], eras?: string[] }
 *   All default to []. Unknown era/genre IDs are silently dropped.
 *   Film IDs not in the catalog are silently dropped.
 *
 * Response:
 *   {
 *     bannerType: 'BACKDROP' | 'GRADIENT',
 *     bannerValue: { filmId, backdropPath } | string,
 *     source: 'screen3' | 'genre' | 'era' | 'gradient-fallback'
 *   }
 *
 * Caching: 24h Upstash with sorted-array keys, same pattern as
 * /api/onboarding/screen3-candidates. Redis failure falls back to a
 * live cascade (cachedQuery handles this internally).
 */
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { cachedQuery } from '@/lib/cache'
import { pickBestBackdrop } from '@/lib/backdrop-selector'
import {
  ERA_BLOCKS,
  GENRE_BLOCKS,
  type EraBlock,
  type GenreBlock,
} from '@/data/onboardingCuration'

const CACHE_TTL = 60 * 60 * 24
const GRADIENT_VALUE = 'midnight'

type Source = 'screen3' | 'genre' | 'era' | 'gradient-fallback'

type BannerResponse =
  | {
      bannerType: 'BACKDROP'
      bannerValue: { filmId: string; backdropPath: string }
      source: 'screen3' | 'genre' | 'era'
    }
  | {
      bannerType: 'GRADIENT'
      bannerValue: string
      source: 'gradient-fallback'
    }

const ERA_BY_ID = new Map(ERA_BLOCKS.map((b) => [b.id, b]))
const GENRE_BY_ID = new Map(GENRE_BLOCKS.map((b) => [b.id, b]))

const FILM_ORDER_BY = [
  { imdbRating: { sort: 'desc' as const, nulls: 'last' as const } },
  { imdbVotes: { sort: 'desc' as const, nulls: 'last' as const } },
  { title: 'asc' as const },
]

const FILM_SELECT = {
  id: true,
  tmdbId: true,
  title: true,
} as const

type CandidateFilm = { id: string; tmdbId: number; title: string }

async function pickFirstWithBackdrop(
  films: CandidateFilm[]
): Promise<{ film: CandidateFilm; backdropPath: string } | null> {
  for (const film of films) {
    const backdropPath = await pickBestBackdrop(film.tmdbId)
    if (backdropPath) return { film, backdropPath }
  }
  return null
}

async function loadFilmsByIds(ids: string[]): Promise<CandidateFilm[]> {
  if (ids.length === 0) return []
  return prisma.film.findMany({
    where: { id: { in: ids }, status: 'ACTIVE' },
    select: FILM_SELECT,
    orderBy: FILM_ORDER_BY,
  })
}

async function loadFilmsByPosterPaths(paths: string[]): Promise<CandidateFilm[]> {
  if (paths.length === 0) return []
  return prisma.film.findMany({
    where: { posterUrl: { in: paths }, status: 'ACTIVE' },
    select: FILM_SELECT,
    orderBy: FILM_ORDER_BY,
  })
}

function uniqueSorted(strings: string[]): string[] {
  return Array.from(new Set(strings)).sort()
}

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawFilmIds = (body as { filmIds?: unknown })?.filmIds
  const rawGenres = (body as { genres?: unknown })?.genres
  const rawEras = (body as { eras?: unknown })?.eras

  if (rawFilmIds !== undefined && !Array.isArray(rawFilmIds)) {
    return Response.json({ error: '`filmIds` must be an array' }, { status: 400 })
  }
  if (rawGenres !== undefined && !Array.isArray(rawGenres)) {
    return Response.json({ error: '`genres` must be an array' }, { status: 400 })
  }
  if (rawEras !== undefined && !Array.isArray(rawEras)) {
    return Response.json({ error: '`eras` must be an array' }, { status: 400 })
  }

  const filmIds: string[] = Array.isArray(rawFilmIds)
    ? rawFilmIds.filter((x): x is string => typeof x === 'string')
    : []
  const genreIds: string[] = Array.isArray(rawGenres)
    ? rawGenres.filter((x): x is string => typeof x === 'string')
    : []
  const eraIds: string[] = Array.isArray(rawEras)
    ? rawEras.filter((x): x is string => typeof x === 'string')
    : []

  // Unknown era/genre IDs are silently dropped, matching screen3-candidates.
  const selectedGenres = genreIds
    .map((id) => GENRE_BY_ID.get(id))
    .filter((b): b is GenreBlock => b !== undefined)
  const selectedEras = eraIds
    .map((id) => ERA_BY_ID.get(id))
    .filter((b): b is EraBlock => b !== undefined)

  // Cache key uses the resolved (known-only) IDs for genres/eras, raw
  // (deduped) strings for filmIds, all sorted so different selection
  // orders collapse to a single entry.
  const sortedFilmIds = uniqueSorted(filmIds)
  const sortedGenreIds = uniqueSorted(selectedGenres.map((b) => b.id))
  const sortedEraIds = uniqueSorted(selectedEras.map((b) => b.id))
  const cacheKey = `onboarding:banner:${sortedFilmIds.join(',')}:${sortedGenreIds.join(',')}:${sortedEraIds.join(',')}`

  try {
    const result = await cachedQuery<BannerResponse>(cacheKey, CACHE_TTL, async () => {
      // STEP 1: Screen 3 picks.
      if (sortedFilmIds.length > 0) {
        const films = await loadFilmsByIds(sortedFilmIds)
        const hit = await pickFirstWithBackdrop(films)
        if (hit) {
          return {
            bannerType: 'BACKDROP',
            bannerValue: { filmId: hit.film.id, backdropPath: hit.backdropPath },
            source: 'screen3',
          }
        }
      }

      // STEP 2: genre-block films.
      if (selectedGenres.length > 0) {
        const paths = uniqueSorted(
          selectedGenres.flatMap((b) => b.films.map((f) => f.posterPath))
        )
        const films = await loadFilmsByPosterPaths(paths)
        const hit = await pickFirstWithBackdrop(films)
        if (hit) {
          return {
            bannerType: 'BACKDROP',
            bannerValue: { filmId: hit.film.id, backdropPath: hit.backdropPath },
            source: 'genre',
          }
        }
      }

      // STEP 3: era-block films.
      if (selectedEras.length > 0) {
        const paths = uniqueSorted(
          selectedEras.flatMap((b) => b.films.map((f) => f.posterPath))
        )
        const films = await loadFilmsByPosterPaths(paths)
        const hit = await pickFirstWithBackdrop(films)
        if (hit) {
          return {
            bannerType: 'BACKDROP',
            bannerValue: { filmId: hit.film.id, backdropPath: hit.backdropPath },
            source: 'era',
          }
        }
      }

      // STEP 4: gradient fallback.
      return {
        bannerType: 'GRADIENT',
        bannerValue: GRADIENT_VALUE,
        source: 'gradient-fallback',
      }
    })

    return Response.json(result)
  } catch (err) {
    apiLogger.error({ err, cacheKey }, 'Select-banner cascade failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

// Exported for type checks elsewhere if needed.
export type { Source, BannerResponse }
