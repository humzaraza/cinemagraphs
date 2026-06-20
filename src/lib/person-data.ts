import { cache } from 'react'
import { prisma } from './prisma'
import { cachedQuery, KEYS, TTL } from './cache'
import { calculateCompositeArc, downsampleDataPoints } from './person-utils'
import type { SentimentDataPoint } from './types'

export type PersonFilmographyEntry = {
  filmId: string
  title: string
  posterUrl: string | null
  // ISO string (not a Date): JSON-safe across the Redis round-trip, so a cache
  // HIT does not hand the render a string where it expects a Date.
  releaseDate: string | null
  runtime: number | null
  roles: string[]
  role: string
  character: string | null
  overallScore: number | null
  sparklineData: { percent: number; score: number }[]
}

export type PersonData = {
  id: string
  name: string
  slug: string
  tmdbPersonId: number
  profilePath: string | null
  biography: string | null
  birthday: string | null
  deathday: string | null
  knownForDepartment: string | null
  // ISO string | null. null = the bio backfill has never been attempted.
  bioFetchedAt: string | null
  filmCount: number
  roles: string[]
  filmography: PersonFilmographyEntry[]
  compositeArc:
    | { arcPoints: { percent: number; score: number }[]; avgScore: number; filmCount: number }
    | null
}

/**
 * Pure read: resolves a person and derives the JSON-safe shape that both the
 * page and the API route render from. No writes, no TMDB calls, so it is safe
 * to cache directly. Called directly by the page (uncached) and through
 * cachedQuery's fetchFn by the API route.
 */
async function fetchPersonData(tmdbPersonId: number): Promise<PersonData | null> {
  const person = await prisma.person.findUnique({
    where: { tmdbPersonId },
    include: {
      films: {
        include: {
          film: {
            select: {
              id: true,
              title: true,
              posterUrl: true,
              releaseDate: true,
              runtime: true,
              sentimentGraph: { select: { overallScore: true, dataPoints: true } },
            },
          },
        },
      },
    },
  })

  if (!person) return null

  const roles = [...new Set(person.films.map((fp) => fp.role))]

  // Deduplicate by filmId, combining roles across credits on the same film.
  const filmMap = new Map<string, PersonFilmographyEntry>()
  for (const fp of person.films) {
    const existing = filmMap.get(fp.film.id)
    if (existing) {
      if (!existing.roles.includes(fp.role)) existing.roles.push(fp.role)
      if (!existing.character && fp.character) existing.character = fp.character
    } else {
      const dataPoints = (fp.film.sentimentGraph?.dataPoints ?? []) as unknown as SentimentDataPoint[]
      filmMap.set(fp.film.id, {
        filmId: fp.film.id,
        title: fp.film.title,
        posterUrl: fp.film.posterUrl,
        // Convert here, on the fresh Prisma Date, before the value is cached.
        releaseDate: fp.film.releaseDate?.toISOString() ?? null,
        runtime: fp.film.runtime,
        roles: [fp.role],
        role: fp.role,
        character: fp.character,
        overallScore: fp.film.sentimentGraph?.overallScore ?? null,
        sparklineData: downsampleDataPoints(dataPoints, 10),
      })
    }
  }
  const filmography = Array.from(filmMap.values())
    .map((f) => ({
      ...f,
      // Primary role for sparkline color: DIRECTOR > ACTOR > other
      role: f.roles.includes('DIRECTOR') ? 'DIRECTOR' : f.roles.includes('ACTOR') ? 'ACTOR' : f.roles[0],
    }))
    .sort((a, b) => {
      const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0
      const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0
      return dateB - dateA
    })

  // Composite arc for directors with 3+ analyzable films
  const directedFilms = person.films
    .filter((fp) => fp.role === 'DIRECTOR')
    .map((fp) => ({
      runtime: fp.film.runtime ?? 0,
      dataPoints: (fp.film.sentimentGraph?.dataPoints ?? []) as unknown as SentimentDataPoint[],
      overallScore: fp.film.sentimentGraph?.overallScore ?? 0,
    }))
    .filter((f) => f.dataPoints.length > 0 && f.runtime > 0)

  let compositeArc: PersonData['compositeArc'] = null
  if (directedFilms.length >= 3) {
    const arc = calculateCompositeArc(directedFilms)
    if (arc) compositeArc = { ...arc, filmCount: directedFilms.length }
  }

  return {
    id: person.id,
    name: person.name,
    slug: person.slug,
    tmdbPersonId: person.tmdbPersonId,
    profilePath: person.profilePath,
    biography: person.biography,
    birthday: person.birthday,
    deathday: person.deathday,
    knownForDepartment: person.knownForDepartment,
    bioFetchedAt: person.bioFetchedAt?.toISOString() ?? null,
    // Raw FilmPerson row count, matching the previous generateMetadata `_count.films`.
    filmCount: person.films.length,
    roles,
    filmography,
    compositeArc,
  }
}

/**
 * Pure, request-deduped read for the STATIC /person/[slug] page and its
 * generateMetadata. Direct Prisma only — NO Redis. An Upstash read here issues a
 * `fetch(..., { cache: 'no-store' })` (see node_modules/@upstash/redis), which
 * inside the statically-generated render flips the route static→dynamic and
 * breaks ISR. That is the PR #77 regression, so the page never touches Redis.
 *
 * React cache() dedupes within one request, so generateMetadata and the page
 * component share a single Postgres read.
 */
export const getPersonData = cache(
  (tmdbPersonId: number): Promise<PersonData | null> => fetchPersonData(tmdbPersonId),
)

/**
 * Redis-cached read for the DYNAMIC /api/person/[slug] route handler ONLY.
 * Next 16 route handlers are not statically generated ("Route Handlers are not
 * cached by default"), so the Upstash no-store fetch is safe here. Stores the
 * derived JSON-safe PersonData under KEYS.person(id) at TTL.PERSON; busted as a
 * unit by syncFilmCredits / syncPersonBio when a person's data changes.
 *
 * Pure read: no writes, no after(). Bio backfill lives in the sync job and the
 * standalone script, never on this path.
 */
export function getPersonDataCached(tmdbPersonId: number): Promise<PersonData | null> {
  return cachedQuery(KEYS.person(tmdbPersonId), TTL.PERSON, () => fetchPersonData(tmdbPersonId))
}
