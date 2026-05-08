/**
 * POST /api/onboarding/screen3-candidates
 *
 * Returns up to 18 film candidates for Screen 3 of the mobile onboarding
 * flow, based on era and genre block selections from the prior screens.
 *
 * Request:
 *   { eras: string[], genres: string[] }
 *   Block IDs from src/data/onboardingCuration.ts. Unknown IDs are
 *   silently dropped (mobile may ship with stale IDs during dev).
 *
 * Response:
 *   {
 *     films: Array<{ id, tmdbId, title, year, posterPath }>,
 *     fallback: 'exact' | 'adjacent' | 'genre-dropped' | 'top-global'
 *   }
 *
 * Algorithm:
 *   - 2+ eras selected: stratify. Run one parallel query per era and
 *     round-robin merge the per-era results so each era is represented
 *     in the early slots. This avoids imdbVotes-desc bias crowding out
 *     older eras with modern blockbusters. If round-robin reaches 18,
 *     fallback = 'exact'. Otherwise the existing fallback chain runs
 *     and APPENDS new (non-overlapping) films to fill the gap; the
 *     fallback name reflects the last stage that contributed.
 *
 *     Per-era query limit: ceil(RESULT_LIMIT / numEras) + PER_ERA_BUFFER.
 *     The buffer lets dense eras pull more candidates when sparse eras
 *     exhaust early. With 4 eras and PER_ERA_BUFFER=3 the per-era take
 *     is 8, so a sparse era returning 1 film can be backfilled by
 *     denser eras up to their per-era cap.
 *   - 0 or 1 era: single-query path (unioned year filter + genres).
 *     Unchanged from before this refactor.
 *
 * Fallback chain (single-query mode, or stratified fill):
 *   1. exact         year + genre + NOT IN 57 mosaic films
 *   2. adjacent      same as 1, but each era's range expanded by ±10y
 *   3. genre-dropped year filter only (still expanded if eras present)
 *   4. top-global    no filters; 57 mosaic films still excluded
 *
 * Caching: Upstash Redis with 24h TTL. Key sorts both arrays so any
 * selection order hits the same cache entry. Redis failure falls back
 * to a live DB query (cachedQuery handles this internally).
 */
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { cachedQuery } from '@/lib/cache'
import {
  ALL_BLOCKS,
  ERA_BLOCKS,
  GENRE_BLOCKS,
  type EraBlock,
} from '@/data/onboardingCuration'

const RESULT_LIMIT = 18
const PER_ERA_BUFFER = 3
const CACHE_TTL = 60 * 60 * 24
const ADJACENT_DECADE_EXPANSION = 10

function perEraTake(numEras: number): number {
  return Math.ceil(RESULT_LIMIT / numEras) + PER_ERA_BUFFER
}

type Fallback = 'exact' | 'adjacent' | 'genre-dropped' | 'top-global'

type ResponseFilm = {
  id: string
  tmdbId: number
  title: string
  year: number
  posterPath: string | null
}

type Screen3Response = {
  films: ResponseFilm[]
  fallback: Fallback
}

const ERA_BY_ID = new Map(ERA_BLOCKS.map((b) => [b.id, b]))
const GENRE_BY_ID = new Map(GENRE_BLOCKS.map((b) => [b.id, b]))

const EXCLUSION_POSTER_PATHS: readonly string[] = Array.from(
  new Set(ALL_BLOCKS.flatMap((b) => b.films.map((f) => f.posterPath)))
)

const ORDER_BY = [
  { imdbVotes: { sort: 'desc' as const, nulls: 'last' as const } },
  { title: 'asc' as const },
]

function buildEraFilter(eras: readonly EraBlock[], expansion: number) {
  if (eras.length === 0) return null
  return {
    OR: eras.map((era) => ({
      releaseDate: {
        gte: new Date(`${era.yearRange[0] - expansion}-01-01T00:00:00.000Z`),
        lt: new Date(`${era.yearRange[1] + expansion + 1}-01-01T00:00:00.000Z`),
      },
    })),
  }
}

function toResponseFilm(f: {
  id: string
  tmdbId: number
  title: string
  releaseDate: Date | null
  posterUrl: string | null
}): ResponseFilm | null {
  // releaseDate is filtered to non-null in the query, but be defensive.
  if (!f.releaseDate) return null
  return {
    id: f.id,
    tmdbId: f.tmdbId,
    title: f.title,
    year: f.releaseDate.getUTCFullYear(),
    posterPath: f.posterUrl,
  }
}

const SELECT_FIELDS = {
  id: true,
  tmdbId: true,
  title: true,
  releaseDate: true,
  posterUrl: true,
} as const

async function queryFilms(
  yearFilter: ReturnType<typeof buildEraFilter>,
  genreTags: string[],
  excludedIds: readonly string[] = [],
  take: number = RESULT_LIMIT
): Promise<ResponseFilm[]> {
  const andClauses: Record<string, unknown>[] = []
  if (yearFilter) andClauses.push(yearFilter)
  if (genreTags.length > 0) andClauses.push({ genres: { hasSome: genreTags } })

  const where: Record<string, unknown> = {
    status: 'ACTIVE',
    releaseDate: { not: null },
    posterUrl: { notIn: EXCLUSION_POSTER_PATHS },
  }
  if (excludedIds.length > 0) {
    where.id = { notIn: excludedIds }
  }
  if (andClauses.length > 0) {
    where.AND = andClauses
  }

  const rows = await prisma.film.findMany({
    where,
    select: SELECT_FIELDS,
    orderBy: ORDER_BY,
    take,
  })

  return rows.map(toResponseFilm).filter((f): f is ResponseFilm => f !== null)
}

function roundRobinMerge(perEra: ResponseFilm[][], limit: number): ResponseFilm[] {
  const merged: ResponseFilm[] = []
  const seen = new Set<string>()
  const maxDepth = perEra.reduce((m, list) => Math.max(m, list.length), 0)
  for (let depth = 0; depth < maxDepth && merged.length < limit; depth++) {
    for (const list of perEra) {
      if (merged.length >= limit) break
      if (depth >= list.length) continue
      const film = list[depth]
      if (seen.has(film.id)) continue
      seen.add(film.id)
      merged.push(film)
    }
  }
  return merged
}

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawEras = (body as { eras?: unknown })?.eras
  const rawGenres = (body as { genres?: unknown })?.genres

  if (rawEras !== undefined && !Array.isArray(rawEras)) {
    return Response.json({ error: '`eras` must be an array' }, { status: 400 })
  }
  if (rawGenres !== undefined && !Array.isArray(rawGenres)) {
    return Response.json({ error: '`genres` must be an array' }, { status: 400 })
  }

  const eraIds: string[] = Array.isArray(rawEras) ? rawEras.filter((x): x is string => typeof x === 'string') : []
  const genreIds: string[] = Array.isArray(rawGenres) ? rawGenres.filter((x): x is string => typeof x === 'string') : []

  // Resolve known blocks. Unknown IDs are silently dropped per spec.
  const selectedEras = eraIds.map((id) => ERA_BY_ID.get(id)).filter((b): b is EraBlock => b !== undefined)
  const selectedGenres = genreIds
    .map((id) => GENRE_BY_ID.get(id))
    .filter((b): b is NonNullable<typeof b> => b !== undefined)
  const selectedGenreTags = Array.from(new Set(selectedGenres.map((b) => b.genreTag)))

  // Cache key uses the resolved (known-only) IDs sorted, so different
  // arrival orders or unknown-ID padding all collapse to one entry.
  const sortedEraIds = selectedEras.map((b) => b.id).sort()
  const sortedGenreIds = selectedGenres.map((b) => b.id).sort()
  const cacheKey = `onboarding:screen3:${sortedEraIds.join(',')}:${sortedGenreIds.join(',')}`

  try {
    const result = await cachedQuery<Screen3Response>(cacheKey, CACHE_TTL, async () => {
      // Edge case: nothing selected (or everything was unknown). Skip
      // straight to top-global so we never run an empty AND query.
      if (selectedEras.length === 0 && selectedGenreTags.length === 0) {
        const films = await queryFilms(null, [])
        return { films, fallback: 'top-global' }
      }

      // Stratification path: 2+ eras. Per-era queries in parallel,
      // round-robin merge so older eras aren't crowded out. Per-era
      // take is sized to the merged limit divided across eras, plus
      // a buffer so dense eras can fill in for sparse ones.
      if (selectedEras.length >= 2) {
        const eraTake = perEraTake(selectedEras.length)
        const perEra = await Promise.all(
          selectedEras.map((era) =>
            queryFilms(buildEraFilter([era], 0), selectedGenreTags, [], eraTake)
          )
        )

        const merged = roundRobinMerge(perEra, RESULT_LIMIT)
        if (merged.length >= RESULT_LIMIT) {
          return { films: merged, fallback: 'exact' }
        }

        // Fall through to the fallback chain, APPENDING new (non-
        // overlapping) films so the round-robin picks are preserved.
        const seenIds = new Set(merged.map((f) => f.id))
        let fallback: Fallback = 'exact'

        const append = (results: ResponseFilm[], stage: Fallback) => {
          let added = 0
          for (const f of results) {
            if (merged.length >= RESULT_LIMIT) break
            if (seenIds.has(f.id)) continue
            seenIds.add(f.id)
            merged.push(f)
            added++
          }
          if (added > 0) fallback = stage
        }

        // Step 2: adjacent decades.
        const adjacent = await queryFilms(
          buildEraFilter(selectedEras, ADJACENT_DECADE_EXPANSION),
          selectedGenreTags,
          Array.from(seenIds)
        )
        append(adjacent, 'adjacent')
        if (merged.length >= RESULT_LIMIT) return { films: merged, fallback }

        // Step 3: drop genre. Only meaningful if a genre was applied.
        if (selectedGenreTags.length > 0) {
          const dropped = await queryFilms(
            buildEraFilter(selectedEras, ADJACENT_DECADE_EXPANSION),
            [],
            Array.from(seenIds)
          )
          append(dropped, 'genre-dropped')
          if (merged.length >= RESULT_LIMIT) return { films: merged, fallback }
        }

        // Step 4: top-global.
        const global = await queryFilms(null, [], Array.from(seenIds))
        append(global, 'top-global')
        return { films: merged, fallback }
      }

      // Single-query path: 0 or 1 era. Unchanged from before this refactor.

      // Step 1: exact.
      const exactYear = buildEraFilter(selectedEras, 0)
      const exact = await queryFilms(exactYear, selectedGenreTags)
      if (exact.length >= RESULT_LIMIT) return { films: exact, fallback: 'exact' }

      // Step 2: expand year range to adjacent decades. Only meaningful if
      // eras were selected; otherwise the expansion is a no-op and we'd
      // re-run an identical query.
      if (selectedEras.length > 0) {
        const adjacentYear = buildEraFilter(selectedEras, ADJACENT_DECADE_EXPANSION)
        const adjacent = await queryFilms(adjacentYear, selectedGenreTags)
        if (adjacent.length >= RESULT_LIMIT) return { films: adjacent, fallback: 'adjacent' }
      }

      // Step 3: drop genre. Only meaningful if a genre was applied.
      if (selectedGenreTags.length > 0) {
        const yearForDrop =
          selectedEras.length > 0
            ? buildEraFilter(selectedEras, ADJACENT_DECADE_EXPANSION)
            : null
        const dropped = await queryFilms(yearForDrop, [])
        if (dropped.length >= RESULT_LIMIT) return { films: dropped, fallback: 'genre-dropped' }
      }

      // Step 4: top-global. Always returns; up to RESULT_LIMIT films
      // from the top-rated set, still excluding the 57 mosaic films.
      const global = await queryFilms(null, [])
      return { films: global, fallback: 'top-global' }
    })

    return Response.json(result)
  } catch (err) {
    apiLogger.error({ err, cacheKey }, 'Screen 3 candidates query failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
