import { prisma } from '@/lib/prisma'
import { notFound } from 'next/navigation'
import { getPersonDetails } from '@/lib/tmdb'
import { calculateCompositeArc, downsampleDataPoints } from '@/lib/person-utils'
import { tmdbImageUrl } from '@/lib/utils'
import Image from 'next/image'
import type { Metadata } from 'next'
import type { SentimentDataPoint } from '@/lib/types'
import { PersonBio } from '@/components/PersonBio'
import { CompositeArcGraph } from '@/components/CompositeArcGraph'
import { PersonFilmography } from '@/components/PersonFilmography'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ slug: string }> }

function parseTmdbIdFromSlug(slug: string): number | null {
  const lastDash = slug.lastIndexOf('-')
  if (lastDash === -1) return null
  const id = parseInt(slug.slice(lastDash + 1), 10)
  return isNaN(id) ? null : id
}

const ROLE_LABELS: Record<string, string> = {
  DIRECTOR: 'Director',
  ACTOR: 'Actor',
  CINEMATOGRAPHER: 'Cinematographer',
  COMPOSER: 'Composer',
  EDITOR: 'Editor',
  WRITER: 'Writer',
  PRODUCER: 'Producer',
}

// Priority order for role display
const ROLE_PRIORITY = ['DIRECTOR', 'ACTOR', 'WRITER', 'PRODUCER', 'CINEMATOGRAPHER', 'COMPOSER', 'EDITOR']

async function getPersonWithFilms(tmdbPersonId: number) {
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
      // TMDB failed — continue without bio
    }
  }

  return person
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const tmdbPersonId = parseTmdbIdFromSlug(slug)
  if (!tmdbPersonId) return { title: 'Person Not Found - Cinemagraphs' }

  const person = await prisma.person.findUnique({
    where: { tmdbPersonId },
    select: { name: true, profilePath: true, _count: { select: { films: true } } },
  })

  if (!person) return { title: 'Person Not Found - Cinemagraphs' }

  const description = `${person.name} filmography with sentiment analysis graphs. ${person._count.films} films analyzed.`

  return {
    title: `${person.name} - Cinemagraphs`,
    description,
    openGraph: {
      title: `${person.name} - Cinemagraphs`,
      description,
      ...(person.profilePath && {
        images: [{ url: tmdbImageUrl(person.profilePath, 'w500'), width: 500, height: 750 }],
      }),
    },
  }
}

export default async function PersonPage({ params }: Props) {
  const { slug } = await params
  const tmdbPersonId = parseTmdbIdFromSlug(slug)
  if (!tmdbPersonId) notFound()

  const person = await getPersonWithFilms(tmdbPersonId)
  if (!person) notFound()

  // Derive roles
  const roles = [...new Set(person.films.map((fp) => fp.role))]
  const roleLabel = ROLE_PRIORITY
    .filter((r) => roles.includes(r as typeof roles[number]))
    .map((r) => ROLE_LABELS[r])
    .join(' / ')

  // Build filmography — deduplicate by filmId, combine roles
  const filmMap = new Map<string, {
    filmId: string
    title: string
    posterUrl: string | null
    releaseDate: string | null
    runtime: number | null
    roles: string[]
    character: string | null
    overallScore: number | null
    sparklineData: { percent: number; score: number }[]
  }>()
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
        releaseDate: fp.film.releaseDate?.toISOString() ?? null,
        runtime: fp.film.runtime,
        roles: [fp.role],
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

  // Composite arc for directors
  const directedFilms = person.films
    .filter((fp) => fp.role === 'DIRECTOR')
    .map((fp) => ({
      runtime: fp.film.runtime ?? 0,
      dataPoints: (fp.film.sentimentGraph?.dataPoints ?? []) as unknown as SentimentDataPoint[],
      overallScore: fp.film.sentimentGraph?.overallScore ?? 0,
    }))
    .filter((f) => f.dataPoints.length > 0 && f.runtime > 0)

  const compositeArc = directedFilms.length >= 3 ? calculateCompositeArc(directedFilms) : null

  // Initials for placeholder
  const initials = person.name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  // Format birthday/deathday
  const formatBioDate = (dateStr: string | null) => {
    if (!dateStr) return null
    try {
      return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    } catch {
      return dateStr
    }
  }

  const birthDate = formatBioDate(person.birthday)
  const deathDate = formatBioDate(person.deathday)

  // JSON-LD
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: person.name,
    ...(person.profilePath && { image: tmdbImageUrl(person.profilePath, 'w500') }),
    ...(person.birthday && { birthDate: person.birthday }),
    ...(person.deathday && { deathDate: person.deathday }),
  }

  return (
    <div className="min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="max-w-4xl mx-auto px-4 pt-8 pb-12">
        {/* Header */}
        <div className="flex flex-col sm:flex-row gap-6">
          {/* Photo */}
          <div className="flex-shrink-0">
            <div className="w-32 h-32 sm:w-40 sm:h-40 rounded-lg overflow-hidden border-2 border-cinema-border relative bg-cinema-darker">
              {person.profilePath ? (
                <Image
                  src={tmdbImageUrl(person.profilePath, 'w185')}
                  alt={person.name}
                  fill
                  unoptimized
                  className="object-cover"
                  priority
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-cinema-muted text-3xl font-bold">
                  {initials}
                </div>
              )}
            </div>
          </div>

          {/* Info */}
          <div className="flex-1">
            {roleLabel && (
              <span className="text-xs font-semibold text-cinema-gold uppercase tracking-wider">
                {roleLabel}
              </span>
            )}
            <h1 className="font-[family-name:var(--font-playfair)] text-3xl md:text-4xl font-bold mt-1">
              {person.name}
            </h1>

            {(birthDate || deathDate) && (
              <p className="text-sm text-cinema-muted mt-2">
                {birthDate && <>Born {birthDate}</>}
                {deathDate && <> &ndash; Died {deathDate}</>}
              </p>
            )}

            {person.biography && <PersonBio biography={person.biography} />}
          </div>
        </div>

        {/* Composite Arc Graph */}
        {compositeArc && (
          <CompositeArcGraph
            arcPoints={compositeArc.arcPoints}
            avgScore={compositeArc.avgScore}
            filmCount={directedFilms.length}
          />
        )}

        {/* Filmography Grid */}
        <PersonFilmography filmography={filmography} />
      </div>
    </div>
  )
}
