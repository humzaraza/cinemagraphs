import { prisma } from '@/lib/prisma'
import FilmCard from '@/components/FilmCard'
import MovieTicker from '@/components/MovieTicker'
import HeroSection from '@/components/HeroSection'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const [featuredFilms, recentFilms, allGraphFilms] = await Promise.all([
    prisma.film.findMany({
      where: { status: 'ACTIVE', isFeatured: true },
      include: { sentimentGraph: { select: { overallScore: true, dataPoints: true } } },
      take: 6,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.film.findMany({
      where: { status: 'ACTIVE' },
      include: { sentimentGraph: { select: { overallScore: true, dataPoints: true } } },
      take: 12,
      orderBy: { createdAt: 'desc' },
    }),
    // For ticker: get films with graphs
    prisma.film.findMany({
      where: { status: 'ACTIVE', sentimentGraph: { isNot: null } },
      include: { sentimentGraph: { select: { overallScore: true, previousScore: true, dataPoints: true } } },
      take: 20,
      orderBy: { updatedAt: 'desc' },
    }),
  ])

  // Build ticker data
  const tickerFilms = allGraphFilms
    .filter((f) => f.sentimentGraph)
    .map((f) => {
      const current = f.sentimentGraph!.overallScore
      const previous = f.sentimentGraph!.previousScore
      const delta = previous != null ? current - previous : 0 // default green (>= 0) when no previous
      return {
        id: f.id,
        title: f.title,
        score: current,
        delta,
        dataPoints: (f.sentimentGraph!.dataPoints as any[]).map((dp: any) => ({
        timeMidpoint: dp.timeMidpoint ?? Math.round(((dp.timeStart ?? 0) + (dp.timeEnd ?? 0)) / 2),
        score: dp.score,
      })),
      }
    })

  // Build hero data from featured films that have graphs
  const heroFilms = featuredFilms
    .filter((f) => f.sentimentGraph && (f.sentimentGraph.dataPoints as any[])?.length > 0)
    .map((f) => ({
      id: f.id,
      title: f.title,
      releaseDate: f.releaseDate?.toISOString() ?? null,
      runtime: f.runtime,
      director: f.director,
      genres: f.genres,
      posterUrl: f.posterUrl,
      backdropUrl: f.backdropUrl,
      tmdbId: f.tmdbId,
      sentimentScore: f.sentimentGraph!.overallScore,
      dataPoints: (f.sentimentGraph!.dataPoints as any[]).map((dp: any) => ({
        timeMidpoint: dp.timeMidpoint ?? Math.round(((dp.timeStart ?? 0) + (dp.timeEnd ?? 0)) / 2),
        timeStart: dp.timeStart ?? 0,
        timeEnd: dp.timeEnd ?? 0,
        score: dp.score,
        label: dp.label ?? '',
        confidence: dp.confidence ?? 'medium',
      })),
    }))

  return (
    <div>
      {/* Movie Market Ticker */}
      <MovieTicker films={tickerFilms} />

      {/* Hero Section — Featured Film Spotlight */}
      {heroFilms.length > 0 ? (
        <HeroSection films={heroFilms} />
      ) : (
        <section className="relative py-20 px-4 text-center bg-gradient-to-b from-cinema-darker to-cinema-dark">
          <div className="max-w-3xl mx-auto">
            <h1 className="font-[family-name:var(--font-playfair)] text-5xl md:text-6xl font-bold mb-4">
              Feel the <span className="text-cinema-gold">Story</span> Unfold
            </h1>
            <p className="text-lg text-cinema-cream/70 mb-8 max-w-xl mx-auto">
              Cinemagraphs visualizes how audience sentiment shifts across a
              film&apos;s runtime — peaks, dips, and the moments that divide viewers.
            </p>
            <Link
              href="/films/browse"
              className="inline-block bg-cinema-gold text-cinema-dark font-semibold px-8 py-3 rounded-lg hover:bg-cinema-gold/90 transition-colors"
            >
              Browse Films
            </Link>
          </div>
        </section>
      )}

      {/* Recently Added */}
      <section className="max-w-7xl mx-auto px-4 py-12">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-[family-name:var(--font-playfair)] text-2xl font-bold">
            Recently Added
          </h2>
          <Link
            href="/films/browse"
            className="text-sm text-cinema-gold hover:text-cinema-gold/80 transition-colors"
          >
            View All &rarr;
          </Link>
        </div>
        {recentFilms.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {recentFilms.map((film) => (
              <FilmCard
                key={film.id}
                id={film.id}
                title={film.title}
                posterUrl={film.posterUrl}
                releaseDate={film.releaseDate?.toISOString() ?? null}
                genres={film.genres}
                sentimentScore={film.sentimentGraph?.overallScore}
                graphDataPoints={film.sentimentGraph?.dataPoints as { timeMidpoint: number; score: number }[] | null}
              />
            ))}
          </div>
        ) : (
          <div className="text-center py-20 text-cinema-muted">
            <p className="text-lg mb-2">No films yet</p>
            <p className="text-sm">Import films from TMDB via the admin dashboard.</p>
          </div>
        )}
      </section>
    </div>
  )
}
