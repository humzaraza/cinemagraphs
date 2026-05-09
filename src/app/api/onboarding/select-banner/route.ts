/**
 * POST /api/onboarding/select-banner
 *
 * Locked policy: pick a banner for a new mobile user based on their
 * onboarding selections, cascading through five candidate sources
 * before giving up to a gradient.
 *
 *   1. SCREEN 3 PASS              Top-rated film among the user's
 *                                 Screen 3 picks with a quality backdrop.
 *   2. ERA + GENRE INTERSECTION   Catalog query (NOT just curation) for
 *                                 films matching any selected era's year
 *                                 range AND any selected genre's DB tag,
 *                                 mosaic films excluded. Honors both
 *                                 signals when both are present.
 *   3. ERA PASS                   Top-rated curated film from any selected
 *                                 era block with a quality backdrop.
 *   4. GENRE PASS                 Top-rated curated film from any selected
 *                                 genre block with a quality backdrop.
 *   5. GRADIENT                   'midnight' fallback (skip-everything
 *                                 path only).
 *
 * Era runs before genre when the intersection fails because era is the
 * stronger temporal signal in onboarding (a user who picked 1980s + Drama
 * almost certainly cares more about getting an 80s film than a generic
 * top-rated drama; if intersection produced nothing, the era curated
 * block is the closer match).
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
 *     source: 'screen3' | 'era-genre-intersection' | 'era' | 'genre'
 *           | 'gradient-fallback'
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
  EXCLUSION_POSTER_PATHS,
  GENRE_BLOCKS,
  type EraBlock,
  type GenreBlock,
} from '@/data/onboardingCuration'

const CACHE_TTL = 60 * 60 * 24
const GRADIENT_VALUE = 'midnight'
const INTERSECTION_TAKE = 10

type Source =
  | 'screen3'
  | 'era-genre-intersection'
  | 'era'
  | 'genre'
  | 'gradient-fallback'

type BannerResponse =
  | {
      bannerType: 'BACKDROP'
      bannerValue: { filmId: string; backdropPath: string }
      source: 'screen3' | 'era-genre-intersection' | 'era' | 'genre'
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

async function loadEraGenreIntersection(
  eras: EraBlock[],
  genreTags: string[]
): Promise<CandidateFilm[]> {
  if (eras.length === 0 || genreTags.length === 0) return []
  // Year-range OR clause uses the same UTC-anchored Date construction
  // as src/app/api/onboarding/screen3-candidates/route.ts so the two
  // routes agree on era boundaries.
  const yearOr = eras.map((era) => ({
    releaseDate: {
      gte: new Date(`${era.yearRange[0]}-01-01T00:00:00.000Z`),
      lt: new Date(`${era.yearRange[1] + 1}-01-01T00:00:00.000Z`),
    },
  }))
  return prisma.film.findMany({
    where: {
      OR: yearOr,
      genres: { hasSome: genreTags },
      status: 'ACTIVE',
      // Curation films are deferred to the era/genre block steps; the
      // intersection step is for catalog discovery. Spread because the
      // shared exclusion is typed `readonly string[]` and Prisma's
      // notIn expects a mutable `string[]`.
      posterUrl: { notIn: [...EXCLUSION_POSTER_PATHS] },
    },
    select: FILM_SELECT,
    orderBy: FILM_ORDER_BY,
    take: INTERSECTION_TAKE,
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
  // v2: cascade semantics changed (added era+genre intersection step,
  // swapped era/genre fallback order). Older v1 cache entries return
  // the wrong source string under the new cascade, so the prefix bump
  // orphans them and forces a fresh compute on first request after deploy.
  const cacheKey = `onboarding:banner:v2:${sortedFilmIds.join(',')}:${sortedGenreIds.join(',')}:${sortedEraIds.join(',')}`

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

      // STEP 2: era + genre intersection. Catalog query (NOT curation)
      // for films matching any selected era's year range AND any selected
      // genre's DB tag. Only fires when both are non-empty.
      if (selectedEras.length > 0 && selectedGenres.length > 0) {
        const genreTags = uniqueSorted(selectedGenres.map((b) => b.genreTag))
        const films = await loadEraGenreIntersection(selectedEras, genreTags)
        const hit = await pickFirstWithBackdrop(films)
        if (hit) {
          return {
            bannerType: 'BACKDROP',
            bannerValue: { filmId: hit.film.id, backdropPath: hit.backdropPath },
            source: 'era-genre-intersection',
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

      // STEP 4: genre-block films.
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

      // STEP 5: gradient fallback.
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
