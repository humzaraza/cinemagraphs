import { prisma } from '@/lib/prisma'
import FilmCard from '@/components/FilmCard'
import MovieTicker from '@/components/MovieTicker'
import HeroSection from '@/components/HeroSection'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const [featuredFilms, recentFilms, allGraphFilms] = await Promise.all([
    // First try admin-selected featured films
    prisma.film.findMany({
      where: { status: 'ACTIVE', isFeatured: true, sentimentGraph: { isNot: null } },
      include: {
        sentimentGraph: { select: { overallScore: true, dataPoints: true } },
      },
      take: 6,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.film.findMany({
      where: { status: 'ACTIVE' },
      include: { sentimentGraph: { select: { overallScore: true, dataPoints: true } } },
      take: 12,
      orderBy: { createdAt: 'desc' },
    }),
    // For ticker: all films with graphs
    prisma.film.findMany({
      where: { status: 'ACTIVE', sentimentGraph: { isNot: null } },
      include: {
        sentimentGraph: { select: { overallScore: true, previousScore: true, dataPoints: true } },
      },
      take: 20,
      orderBy: { updatedAt: 'desc' },
    }),
  ])

  // If no admin-selected featured films, use top-scored films with graphs
  const heroSourceFilms = featuredFilms.length > 0
    ? featuredFilms
    : await prisma.film.findMany({
        where: { status: 'ACTIVE', sentimentGraph: { isNot: null } },
        include: {
          sentimentGraph: { select: { overallScore: true, dataPoints: true } },
        },
        take: 5,
        orderBy: { sentimentGraph: { overallScore: 'desc' } },
      })

  // Build ticker data
  const tickerFilms = allGraphFilms
    .filter((f) => f.sentimentGraph)
    .map((f) => {
      const current = f.sentimentGraph!.overallScore
      const previous = f.sentimentGraph!.previousScore
      const delta = previous != null ? current - previous : 0
      return {
        id: f.id,
        title: f.title,
        score: current,
        delta,
        dataPoints: (f.sentimentGraph!.dataPoints as unknown as any[]).map((dp: any) => ({
          timeMidpoint: dp.timeMidpoint ?? Math.round(((dp.timeStart ?? 0) + (dp.timeEnd ?? 0)) / 2),
          score: dp.score,
        })),
      }
    })

  // Build hero data
  const heroFilms = heroSourceFilms
    .filter((f) => f.sentimentGraph && (f.sentimentGraph.dataPoints as unknown as any[])?.length > 0)
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
      dataPoints: (f.sentimentGraph!.dataPoints as unknown as any[]).map((dp: any) => ({
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
      <HeroSection films={heroFilms} />

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
                graphDataPoints={film.sentimentGraph?.dataPoints as unknown as { timeMidpoint: number; score: number }[] | null}
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
