import { notFound } from 'next/navigation'
import { tmdbImageUrl } from '@/lib/utils'
import Image from 'next/image'
import type { Metadata } from 'next'
import { getPersonData } from '@/lib/person-data'
import { PersonBio } from '@/components/PersonBio'
import { CompositeArcGraph } from '@/components/CompositeArcGraph'
import { PersonFilmography } from '@/components/PersonFilmography'

// Cache person pages with ISR; 3600s matches TTL.PERSON. Repeat visits and
// crawler hits then serve cached HTML instead of re-querying Neon every time.
export const revalidate = 3600

// Next 16 only engages runtime ISR for on-demand dynamic params when the route
// returns an empty array from generateStaticParams (or sets dynamic = 'force-static').
// Without this companion the `revalidate` above is inert and every /person/<slug>
// renders dynamically, hitting Postgres on every view. Empty array = prerender
// nothing at build, generate each page statically on first visit, revalidate hourly.
export async function generateStaticParams() {
  return []
}

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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const tmdbPersonId = parseTmdbIdFromSlug(slug)
  if (!tmdbPersonId) return { title: 'Person Not Found - Cinemagraphs' }

  const person = await getPersonData(tmdbPersonId)
  if (!person) return { title: 'Person Not Found - Cinemagraphs' }

  const description = `${person.name} filmography with sentiment analysis graphs. ${person.filmCount} films analyzed.`

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

  const person = await getPersonData(tmdbPersonId)
  if (!person) notFound()

  // Role label from the distinct roles on the shared shape
  const roleLabel = ROLE_PRIORITY
    .filter((r) => person.roles.includes(r))
    .map((r) => ROLE_LABELS[r])
    .join(' / ')

  const filmography = person.filmography
  const compositeArc = person.compositeArc

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
            filmCount={compositeArc.filmCount}
          />
        )}

        {/* Filmography Grid */}
        <PersonFilmography filmography={filmography} />
      </div>
    </div>
  )
}
