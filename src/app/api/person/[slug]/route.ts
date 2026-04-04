import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getPersonDetails } from '@/lib/tmdb'
import { cachedQuery, KEYS, TTL } from '@/lib/cache'
import { calculateCompositeArc, downsampleDataPoints } from '@/lib/person-utils'
import type { SentimentDataPoint } from '@/lib/types'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params

  // Extract tmdbPersonId from slug (last segment after final dash)
  const lastDash = slug.lastIndexOf('-')
  if (lastDash === -1) {
    return NextResponse.json({ error: 'Invalid slug' }, { status: 400 })
  }
  const tmdbPersonId = parseInt(slug.slice(lastDash + 1), 10)
  if (isNaN(tmdbPersonId)) {
    return NextResponse.json({ error: 'Invalid slug' }, { status: 400 })
  }

  const data = await cachedQuery(
    KEYS.person(tmdbPersonId),
    TTL.PERSON,
    () => fetchPersonData(tmdbPersonId),
  )

  if (!data) {
    return NextResponse.json({ error: 'Person not found' }, { status: 404 })
  }

  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' },
  })
}

async function fetchPersonData(tmdbPersonId: number) {
  let person = await prisma.person.findUnique({
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
              sentimentGraph: {
                select: {
                  overallScore: true,
                  dataPoints: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (!person) return null

  // Lazy-fetch bio from TMDB on first visit
  if (person.biography === null) {
    try {
      const tmdbPerson = await getPersonDetails(tmdbPersonId)
      person = await prisma.person.update({
        where: { tmdbPersonId },
        data: {
          biography: tmdbPerson.biography || null,
          birthday: tmdbPerson.birthday || null,
          deathday: tmdbPerson.deathday || null,
          knownForDepartment: tmdbPerson.known_for_department || person.knownForDepartment,
        },
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
                  sentimentGraph: {
                    select: {
                      overallScore: true,
                      dataPoints: true,
                    },
                  },
                },
              },
            },
          },
        },
      })
    } catch {
      // TMDB fetch failed — continue with what we have
    }
  }

  // Derive distinct roles
  const roles = [...new Set(person.films.map((fp) => fp.role))]

  // Build filmography with downsampled sparkline data
  const filmography = person.films
    .map((fp) => {
      const dataPoints = (fp.film.sentimentGraph?.dataPoints ?? []) as unknown as SentimentDataPoint[]
      return {
        filmId: fp.film.id,
        title: fp.film.title,
        posterUrl: fp.film.posterUrl,
        releaseDate: fp.film.releaseDate,
        runtime: fp.film.runtime,
        role: fp.role,
        character: fp.character,
        overallScore: fp.film.sentimentGraph?.overallScore ?? null,
        sparklineData: downsampleDataPoints(dataPoints, 10),
      }
    })
    .sort((a, b) => {
      const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0
      const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0
      return dateB - dateA
    })

  // Composite arc for directors with 3+ films
  let compositeArc = null
  const directedFilms = person.films
    .filter((fp) => fp.role === 'DIRECTOR')
    .map((fp) => ({
      runtime: fp.film.runtime ?? 0,
      dataPoints: (fp.film.sentimentGraph?.dataPoints ?? []) as unknown as SentimentDataPoint[],
      overallScore: fp.film.sentimentGraph?.overallScore ?? 0,
    }))
    .filter((f) => f.dataPoints.length > 0 && f.runtime > 0)

  if (directedFilms.length >= 3) {
    compositeArc = calculateCompositeArc(directedFilms)
    if (compositeArc) {
      (compositeArc as any).filmCount = directedFilms.length
    }
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
    roles,
    filmography,
    compositeArc,
  }
}
