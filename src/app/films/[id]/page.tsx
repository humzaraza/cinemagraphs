import { prisma } from '@/lib/prisma'
import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'
import Image from 'next/image'
import { tmdbImageUrl, formatRuntime, formatDate } from '@/lib/utils'
import SentimentGraph from '@/components/SentimentGraph'

interface CastMember {
  name: string
  character: string
  profilePath?: string
}

export default async function FilmPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const film = await prisma.film.findUnique({
    where: { id },
    include: { sentimentGraph: true },
  })

  if (!film) notFound()

  const cast = (film.cast as CastMember[] | null) ?? []

  return (
    <div>
      {/* Backdrop */}
      <div className="relative h-[40vh] min-h-[300px]">
        {film.backdropUrl ? (
          <Image
            src={tmdbImageUrl(film.backdropUrl, 'w1280')}
            alt={film.title}
            fill
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
              {film.director && <span>&middot; Dir. {film.director}</span>}
            </div>

            {film.genres.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {film.genres.map((genre) => (
                  <span
                    key={genre}
                    className="text-xs px-3 py-1 rounded-full bg-cinema-gold/10 text-cinema-gold border border-cinema-gold/20"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            )}

            {/* Ratings */}
            <div className="flex gap-6 mb-6">
              {film.imdbRating != null && (
                <div>
                  <span className="text-xs text-cinema-muted block">IMDb</span>
                  <span className="font-[family-name:var(--font-bebas)] text-2xl text-cinema-gold">
                    {film.imdbRating.toFixed(1)}
                  </span>
                </div>
              )}
              {film.rtCriticsScore != null && (
                <div>
                  <span className="text-xs text-cinema-muted block">RT Critics</span>
                  <span className="font-[family-name:var(--font-bebas)] text-2xl text-cinema-teal">
                    {film.rtCriticsScore}%
                  </span>
                </div>
              )}
              {film.metacriticScore != null && (
                <div>
                  <span className="text-xs text-cinema-muted block">Metacritic</span>
                  <span className="font-[family-name:var(--font-bebas)] text-2xl text-cinema-cream">
                    {film.metacriticScore}
                  </span>
                </div>
              )}
            </div>

            {film.synopsis && (
              <p className="text-cinema-cream/80 leading-relaxed mb-8">{film.synopsis}</p>
            )}
          </div>
        </div>

        {/* Sentiment Graph */}
        {film.sentimentGraph && (
          <div className="mt-10">
            <SentimentGraph
              dataPoints={film.sentimentGraph.dataPoints as { position: number; sentiment: number; label?: string }[]}
              overallScore={film.sentimentGraph.overallScore}
              peakMoment={film.sentimentGraph.peakMoment as { position: number; sentiment: number; label?: string } | null}
              lowestMoment={film.sentimentGraph.lowestMoment as { position: number; sentiment: number; label?: string } | null}
              runtime={film.runtime}
            />
            {film.sentimentGraph.summary && (
              <p className="mt-4 text-sm text-cinema-muted italic">
                {film.sentimentGraph.summary}
              </p>
            )}
          </div>
        )}

        {/* Cast */}
        {cast.length > 0 && (
          <div className="mt-10 pb-12">
            <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-4">
              Cast
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
              {cast.map((member) => (
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
        )}
      </div>
    </div>
  )
}
