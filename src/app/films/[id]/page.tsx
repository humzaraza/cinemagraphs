import { prisma } from '@/lib/prisma'
import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'
import Image from 'next/image'
import Link from 'next/link'
import { tmdbImageUrl, formatRuntime, formatDate } from '@/lib/utils'
import { getMovieTrailerKey } from '@/lib/tmdb'
import SentimentGraph from '@/components/SentimentGraph'
import TrailerButton from '@/components/TrailerButton'
import WatchlistButton from '@/components/WatchlistButton'
import FilmCommunityTabs from '@/components/FilmCommunityTabs'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { FilmFullCast } from '@/components/FilmFullCast'
import type { CastMember, PeakLowMoment, SentimentDataPoint } from '@/lib/types'

const CREW_ROLE_LABELS: Record<string, string> = {
  CINEMATOGRAPHER: 'Cinematography',
  COMPOSER: 'Music',
  EDITOR: 'Editor',
  WRITER: 'Writer',
  PRODUCER: 'Producer',
}

const CREW_ROLE_ORDER = ['CINEMATOGRAPHER', 'COMPOSER', 'EDITOR', 'WRITER', 'PRODUCER']

export default async function FilmPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [film, userReviews] = await Promise.all([
    prisma.film.findUnique({
      where: { id },
      include: {
        sentimentGraph: true,
        filmBeats: true,
        filmPersons: {
          include: {
            person: {
              select: { name: true, slug: true, profilePath: true },
            },
          },
          orderBy: { order: 'asc' },
        },
      },
    }),
    prisma.userReview.findMany({
      where: { filmId: id, status: 'approved' },
      select: {
        overallRating: true,
        combinedText: true,
        createdAt: true,
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ])

  if (!film) notFound()

  const trailerKey = await getMovieTrailerKey(film.tmdbId)

  // Derive cast/crew from FilmPerson records
  const hasFilmPersons = film.filmPersons.length > 0
  const directors = film.filmPersons.filter((fp) => fp.role === 'DIRECTOR')
  const allCast = film.filmPersons
    .filter((fp) => fp.role === 'ACTOR')
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
  const topCast = allCast.slice(0, 6)
  const remainingCastCount = Math.max(0, allCast.length - 6)

  // Crew grouped by role
  const crewByRole: { role: string; label: string; people: { name: string; slug: string }[] }[] = []
  for (const roleKey of CREW_ROLE_ORDER) {
    const members = film.filmPersons
      .filter((fp) => fp.role === roleKey)
      .map((fp) => ({ name: fp.person.name, slug: fp.person.slug }))
    if (members.length > 0) {
      crewByRole.push({ role: roleKey, label: CREW_ROLE_LABELS[roleKey], people: members })
    }
  }

  // Fallback to old cast JSON if no FilmPerson records
  const legacyCast = (film.cast as CastMember[] | null) ?? []

  // Build Schema.org JSON-LD structured data
  const directorName = directors.length > 0 ? directors[0].person.name : film.director
  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Movie',
    name: film.title,
    ...(film.releaseDate && { datePublished: film.releaseDate.toISOString().split('T')[0] }),
    ...(directorName && { director: { '@type': 'Person', name: directorName } }),
    ...(film.synopsis && { description: film.synopsis }),
    ...(film.posterUrl && { image: tmdbImageUrl(film.posterUrl, 'w500') }),
    ...(film.genres.length > 0 && { genre: film.genres }),
  }

  if (film.sentimentGraph) {
    jsonLd.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: film.sentimentGraph.overallScore,
      bestRating: 10,
      worstRating: 1,
      ratingCount: film.sentimentGraph.reviewCount,
    }
  }

  if (userReviews.length > 0) {
    jsonLd.review = userReviews
      .filter((r) => r.combinedText)
      .map((r) => ({
        '@type': 'Review',
        author: { '@type': 'Person', name: r.user.name || 'Anonymous' },
        datePublished: r.createdAt.toISOString().split('T')[0],
        reviewRating: {
          '@type': 'Rating',
          ratingValue: r.overallRating,
          bestRating: 10,
          worstRating: 1,
        },
        reviewBody: r.combinedText,
      }))
  }

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* Backdrop */}
      <div className="relative h-[40vh] min-h-[300px]">
        {film.backdropUrl ? (
          <Image
            src={tmdbImageUrl(film.backdropUrl, 'w1280')}
            alt={film.title}
            fill
            unoptimized
            className="object-cover"
            priority
          />
        ) : (
          <div className="w-full h-full bg-cinema-darker" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-cinema-dark via-cinema-dark/60 to-transparent" />
      </div>

      <div className="max-w-6xl mx-auto px-4 -mt-32 relative z-10">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Poster */}
          <div className="flex-shrink-0 w-48 md:w-64">
            <div className="relative aspect-[2/3] rounded-lg overflow-hidden border-2 border-cinema-border shadow-2xl">
              {film.posterUrl ? (
                <Image
                  src={tmdbImageUrl(film.posterUrl, 'w500')}
                  alt={film.title}
                  fill
                  unoptimized
                  className="object-cover"
                  priority
                />
              ) : (
                <div className="w-full h-full bg-cinema-darker flex items-center justify-center text-cinema-muted">
                  No Poster
                </div>
              )}
            </div>
          </div>

          {/* Details */}
          <div className="flex-1 pt-4 md:pt-16">
            <h1 className="font-[family-name:var(--font-playfair)] text-3xl md:text-4xl font-bold mb-2">
              {film.title}
            </h1>

            <div className="flex flex-wrap items-center gap-3 text-sm text-cinema-muted mb-4">
              {film.releaseDate && <span>{formatDate(film.releaseDate)}</span>}
              {film.runtime && <span>&middot; {formatRuntime(film.runtime)}</span>}
            </div>

            {/* Genre pills */}
            {film.genres.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {film.genres.map((genre) => (
                  <Link
                    key={genre}
                    href={`/films/browse?genre=${encodeURIComponent(genre)}`}
                    className="text-xs px-3 py-1 rounded-full bg-cinema-gold/10 text-cinema-gold border border-cinema-gold/20 hover:border-cinema-gold/60 hover:bg-cinema-gold/20 transition-colors"
                  >
                    {genre}
                  </Link>
                ))}
              </div>
            )}

            {/* Director card(s) */}
            {hasFilmPersons && directors.length > 0 ? (
              <div className="mb-3">
                <span className="text-[11px] uppercase tracking-wider text-cinema-gold font-semibold">
                  Directed by
                </span>
                <div className="flex flex-wrap gap-2 mt-1">
                  {directors.map((fp) => (
                    <Link
                      key={fp.person.slug}
                      href={`/person/${fp.person.slug}`}
                      className="text-sm font-medium text-cinema-gold bg-[#C8A95112] border border-[#C8A95133] rounded-lg px-3 py-1.5 hover:bg-[#C8A95125] hover:border-[#C8A95166] transition-colors"
                    >
                      {fp.person.name}
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              film.director && (
                <div className="mb-3">
                  <span className="text-[11px] uppercase tracking-wider text-cinema-gold font-semibold">
                    Directed by
                  </span>
                  <p className="text-sm font-medium text-cinema-gold mt-1">{film.director}</p>
                </div>
              )
            )}

            {/* Cast pills (top 6) */}
            {hasFilmPersons && topCast.length > 0 && (
              <div className="mb-4">
                <span className="text-[11px] uppercase tracking-wider text-[#888] font-semibold">
                  Cast
                </span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {topCast.map((fp) => (
                    <Link
                      key={fp.person.slug}
                      href={`/person/${fp.person.slug}`}
                      className="text-[13px] text-[#2DD4A8] bg-[#2DD4A808] border border-[#2DD4A833] rounded-full px-2.5 py-0.5 hover:bg-[#2DD4A818] hover:border-[#2DD4A866] transition-colors"
                    >
                      {fp.person.name}
                    </Link>
                  ))}
                  {remainingCastCount > 0 && (
                    <a
                      href="#full-cast"
                      className="text-[13px] text-[#888] bg-transparent border border-[#88888833] rounded-full px-2.5 py-0.5 hover:border-[#88888866] transition-colors"
                    >
                      +{remainingCastCount} more ↓
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Sentiment Score */}
            {film.sentimentGraph && (
              <div className="mb-6">
                <span className="text-xs text-cinema-muted block">Cinemagraphs Score</span>
                <span className="font-[family-name:var(--font-bebas)] text-3xl text-cinema-gold">
                  {film.sentimentGraph.overallScore.toFixed(1)}
                </span>
              </div>
            )}

            {film.synopsis && (
              <p className="text-cinema-cream/80 leading-relaxed mb-6">{film.synopsis}</p>
            )}

            <div className="flex items-center gap-3 mb-8">
              {trailerKey && <TrailerButton trailerKey={trailerKey} />}
              <WatchlistButton
                filmId={film.id}
                size="md"
                className="inline-flex items-center justify-center border border-cinema-gold/30 text-cinema-gold px-3.5 py-2.5 rounded-lg hover:bg-cinema-gold/10 hover:border-cinema-gold transition-colors"
              />
            </div>
          </div>
        </div>

        {/* Sentiment Graph */}
        <div className="mt-10">
          <ErrorBoundary>
            {film.sentimentGraph ? (
              <SentimentGraph
                dataPoints={(film.sentimentGraph.dataPoints ?? []) as unknown as SentimentDataPoint[]}
                overallScore={film.sentimentGraph.overallScore}
                anchoredFrom={film.sentimentGraph.anchoredFrom}
                peakMoment={film.sentimentGraph.peakMoment as unknown as PeakLowMoment | null}
                lowestMoment={film.sentimentGraph.lowestMoment as unknown as PeakLowMoment | null}
                biggestSwing={film.sentimentGraph.biggestSwing}
                summary={film.sentimentGraph.summary}
                sourcesUsed={film.sentimentGraph.sourcesUsed}
                reviewCount={film.sentimentGraph.reviewCount}
                runtime={film.runtime}
                filmId={film.id}
                generatedAt={film.sentimentGraph.generatedAt.toISOString()}
              />
            ) : (
              <SentimentGraph
                dataPoints={[]}
                overallScore={0}
                runtime={film.runtime}
              />
            )}
          </ErrorBoundary>
        </div>

        {/* Full Cast Grid */}
        {hasFilmPersons && allCast.length > 0 ? (
          <div className="mt-10" id="full-cast">
            <FilmFullCast
              cast={allCast.map((fp) => ({
                name: fp.person.name,
                slug: fp.person.slug,
                character: fp.character,
                profilePath: fp.person.profilePath,
              }))}
            />
          </div>
        ) : (
          legacyCast.length > 0 && (
            <div className="mt-10 pb-4" id="full-cast">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-4">
                Cast
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
                {legacyCast.map((member) => (
                  <div
                    key={member.name}
                    className="bg-cinema-card border border-cinema-border rounded-lg p-3"
                  >
                    <p className="text-sm font-semibold text-cinema-cream truncate">
                      {member.name}
                    </p>
                    <p className="text-xs text-cinema-muted truncate">{member.character}</p>
                  </div>
                ))}
              </div>
            </div>
          )
        )}

        {/* Crew Section */}
        {crewByRole.length > 0 && (
          <div className="mt-8">
            <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-4">
              Crew
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2">
              {crewByRole.map((group) => (
                <div key={group.role} className="flex items-baseline gap-3 py-1.5">
                  <span className="text-sm text-[#888] flex-shrink-0 w-28">
                    {group.label}
                  </span>
                  <span className="text-sm">
                    {group.people.map((p, i) => (
                      <span key={p.slug}>
                        {i > 0 && ', '}
                        <Link
                          href={`/person/${p.slug}`}
                          className="text-[#2DD4A8] hover:underline"
                        >
                          {p.name}
                        </Link>
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Community Reviews & Live Reactions */}
        <div className="mt-10">
          <FilmCommunityTabs
            filmId={film.id}
            hasGraph={!!film.sentimentGraph}
            beats={(() => {
              if (film.sentimentGraph) {
                const points = (film.sentimentGraph.dataPoints as unknown as SentimentDataPoint[]) || []
                return points.map((dp) => ({ label: dp.label, score: dp.score }))
              }
              if (film.filmBeats) {
                const wikiBeats = (film.filmBeats.beats as unknown as { label: string }[]) || []
                // Wiki beats have no score — use neutral 5.5 so peak/lowest tagging is disabled
                return wikiBeats.map((b) => ({ label: b.label, score: 5.5 }))
              }
              return []
            })()}
            beatSource={film.sentimentGraph ? 'graph' : film.filmBeats ? 'wiki' : 'none'}
            runtime={film.runtime}
          />
        </div>

        {/* Bottom spacer */}
        <div className="pb-12" />
      </div>
    </div>
  )
}
