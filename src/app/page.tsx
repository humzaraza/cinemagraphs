import { prisma } from '@/lib/prisma'
import FilmCard from '@/components/FilmCard'
import MovieTicker from '@/components/MovieTicker'
import HeroSection from '@/components/HeroSection'
import Link from 'next/link'
import Image from 'next/image'
import { tmdbImageUrl } from '@/lib/utils'
import { getMovieTrailerKey } from '@/lib/tmdb'

export const dynamic = 'force-dynamic'

interface PeakLow {
  score: number
  [key: string]: unknown
}

export default async function HomePage() {
  const [featuredFilms, recentFilms, allGraphFilms, topRatedFilms, allSwingFilms, allGenres] = await Promise.all([
    // Admin-selected featured films
    prisma.film.findMany({
      where: { status: 'ACTIVE', isFeatured: true, sentimentGraph: { isNot: null } },
      include: {
        sentimentGraph: { select: { overallScore: true, dataPoints: true } },
      },
      take: 6,
      orderBy: { createdAt: 'desc' },
    }),
    // Latest releases: films released in the last 2 weeks
    prisma.film.findMany({
      where: {
        status: 'ACTIVE',
        releaseDate: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
      },
      include: { sentimentGraph: { select: { overallScore: true, dataPoints: true } } },
      take: 12,
      orderBy: { releaseDate: 'desc' },
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
    // Top rated by sentiment
    prisma.film.findMany({
      where: { status: 'ACTIVE', sentimentGraph: { isNot: null } },
      include: {
        sentimentGraph: { select: { overallScore: true, dataPoints: true } },
      },
      take: 10,
      orderBy: { sentimentGraph: { overallScore: 'desc' } },
    }),
    // For biggest swings calculation
    prisma.film.findMany({
      where: { status: 'ACTIVE', sentimentGraph: { isNot: null } },
      include: {
        sentimentGraph: { select: { overallScore: true, dataPoints: true, peakMoment: true, lowestMoment: true } },
      },
    }),
    // All genres
    prisma.film.findMany({
      where: { status: 'ACTIVE' },
      select: { genres: true },
    }),
  ])

  // If fewer than 5 latest releases, expand window to 4 weeks
  let latestReleases = recentFilms
  if (latestReleases.length < 5) {
    latestReleases = await prisma.film.findMany({
      where: {
        status: 'ACTIVE',
        releaseDate: { gte: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000) },
      },
      include: { sentimentGraph: { select: { overallScore: true, dataPoints: true } } },
      take: 12,
      orderBy: { releaseDate: 'desc' },
    })
  }

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

  // Fetch trailer keys for hero films
  const heroTrailerKeys = await Promise.all(
    heroSourceFilms.map((f) => getMovieTrailerKey(f.tmdbId))
  )

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
    .map((f, i) => ({
      id: f.id,
      title: f.title,
      releaseDate: f.releaseDate?.toISOString() ?? null,
      runtime: f.runtime,
      director: f.director,
      genres: f.genres,
      synopsis: f.synopsis ?? null,
      posterUrl: f.posterUrl,
      backdropUrl: f.backdropUrl,
      tmdbId: f.tmdbId,
      trailerKey: heroTrailerKeys[i] ?? null,
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

  // Biggest sentiment swings
  const swingFilms = allSwingFilms
    .map((f) => {
      const peak = f.sentimentGraph?.peakMoment as unknown as PeakLow | null
      const low = f.sentimentGraph?.lowestMoment as unknown as PeakLow | null
      const swing = peak && low ? Math.abs(peak.score - low.score) : 0
      const lowScore = low?.score ?? 5
      const highScore = peak?.score ?? 5
      return { film: f, swing, lowScore, highScore }
    })
    .filter((s) => s.swing > 0)
    .sort((a, b) => b.swing - a.swing)
    .slice(0, 10)

  // Latest trailers: recently added films with TMDB trailers
  const recentForTrailers = await prisma.film.findMany({
    where: { status: 'ACTIVE', backdropUrl: { not: null } },
    select: { id: true, tmdbId: true, title: true, genres: true, backdropUrl: true },
    take: 15,
    orderBy: { createdAt: 'desc' },
  })

  const trailerCards: { id: string; title: string; genres: string[]; backdropUrl: string; trailerKey: string }[] = []
  for (const film of recentForTrailers) {
    if (trailerCards.length >= 3) break
    const key = await getMovieTrailerKey(film.tmdbId)
    if (key && film.backdropUrl) {
      trailerCards.push({
        id: film.id,
        title: film.title,
        genres: film.genres,
        backdropUrl: film.backdropUrl,
        trailerKey: key,
      })
    }
  }

  // Unique genres across all films
  const genreSet = new Set<string>()
  allGenres.forEach((f) => f.genres.forEach((g) => genreSet.add(g)))
  const genres = Array.from(genreSet).sort()

  return (
    <div>
      {/* Movie Market Ticker */}
      <MovieTicker films={tickerFilms} />

      {/* Hero Section — Featured Film Spotlight */}
      <HeroSection films={heroFilms} />

      {/* Latest Releases */}
      <section className="max-w-7xl mx-auto px-4 py-12">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-[family-name:var(--font-playfair)] text-2xl font-bold">
            Latest Releases
          </h2>
          <Link
            href="/films/browse"
            className="text-sm text-cinema-gold hover:text-cinema-gold/80 transition-colors"
          >
            View All &rarr;
          </Link>
        </div>
        {latestReleases.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {latestReleases.map((film) => (
              <FilmCard
                key={film.id}
                id={film.id}
                title={film.title}
                posterUrl={film.posterUrl}
                releaseDate={film.releaseDate?.toISOString() ?? null}
                genres={film.genres}
                sentimentScore={film.sentimentGraph?.overallScore}
                graphDataPoints={film.sentimentGraph?.dataPoints as unknown as { timeMidpoint: number; score: number }[] | null}
                runtime={film.runtime}
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

      {/* Top Rated */}
      {topRatedFilms.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 py-12">
          <div className="flex items-center justify-between mb-6">
            <h2 className="font-[family-name:var(--font-playfair)] text-2xl font-bold">
              Top Rated
            </h2>
            <Link
              href="/films/browse"
              className="text-sm text-cinema-gold hover:text-cinema-gold/80 transition-colors"
            >
              View All &rarr;
            </Link>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-cinema-border scrollbar-track-transparent">
            {topRatedFilms.map((film, i) => (
              <div key={film.id} className="flex-shrink-0 w-[180px] relative">
                <FilmCard
                  id={film.id}
                  title={film.title}
                  posterUrl={film.posterUrl}
                  releaseDate={film.releaseDate?.toISOString() ?? null}
                  genres={film.genres}
                  sentimentScore={film.sentimentGraph?.overallScore}
                  graphDataPoints={film.sentimentGraph?.dataPoints as unknown as { timeMidpoint: number; score: number }[] | null}
                  runtime={film.runtime}
                />
                {/* Rank badge */}
                <div className="absolute bottom-[88px] left-2 z-10 bg-cinema-gold text-cinema-dark font-[family-name:var(--font-bebas)] text-lg w-8 h-8 flex items-center justify-center rounded-full shadow-lg">
                  {i + 1}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Biggest Sentiment Swings */}
      {swingFilms.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 py-12">
          <div className="flex items-center justify-between mb-6">
            <h2 className="font-[family-name:var(--font-playfair)] text-2xl font-bold">
              Biggest Sentiment Swings
            </h2>
            <Link
              href="/films/browse"
              className="text-sm text-cinema-gold hover:text-cinema-gold/80 transition-colors"
            >
              View All &rarr;
            </Link>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-cinema-border scrollbar-track-transparent">
            {swingFilms.map(({ film, lowScore, highScore }) => (
              <div key={film.id} className="flex-shrink-0 w-[180px] relative">
                <FilmCard
                  id={film.id}
                  title={film.title}
                  posterUrl={film.posterUrl}
                  releaseDate={film.releaseDate?.toISOString() ?? null}
                  genres={film.genres}
                  sentimentScore={film.sentimentGraph?.overallScore}
                  graphDataPoints={film.sentimentGraph?.dataPoints as unknown as { timeMidpoint: number; score: number }[] | null}
                  runtime={film.runtime}
                />
                {/* Swing badge */}
                <div className="absolute bottom-[88px] left-2 z-10 bg-cinema-darker/90 backdrop-blur-sm border border-cinema-border text-cinema-cream text-xs font-semibold px-2 py-1 rounded shadow-lg">
                  ↕ {lowScore.toFixed(0)}→{highScore.toFixed(0)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Latest Trailers */}
      {trailerCards.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 py-12">
          <h2 className="font-[family-name:var(--font-playfair)] text-2xl font-bold mb-6">
            Latest Trailers
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {trailerCards.map((t) => (
              <a
                key={t.id}
                href={`https://www.youtube.com/watch?v=${t.trailerKey}`}
                target="_blank"
                rel="noopener noreferrer"
                className="group relative rounded-xl overflow-hidden aspect-video"
              >
                <Image
                  src={tmdbImageUrl(t.backdropUrl, 'w780')}
                  alt={t.title}
                  fill
                  className="object-cover group-hover:scale-105 transition-transform duration-500"
                  sizes="(max-width: 768px) 100vw, 33vw"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                {/* Play button */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full bg-cinema-gold/90 flex items-center justify-center group-hover:bg-cinema-gold group-hover:scale-110 transition-all duration-300 shadow-xl">
                    <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7 ml-1">
                      <path d="M8 5v14l11-7L8 5z" fill="#0D0D1A" />
                    </svg>
                  </div>
                </div>
                {/* Title overlay */}
                <div className="absolute bottom-0 left-0 right-0 p-4">
                  <h3 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-white leading-tight">
                    {t.title}
                  </h3>
                  {t.genres.length > 0 && (
                    <p className="text-xs text-cinema-muted mt-1">
                      {t.genres.slice(0, 3).join(' / ')}
                    </p>
                  )}
                </div>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Browse by Genre */}
      {genres.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 py-12">
          <h2 className="font-[family-name:var(--font-playfair)] text-2xl font-bold mb-6">
            Browse by Genre
          </h2>
          <div className="flex flex-wrap gap-3">
            {genres.map((genre) => (
              <Link
                key={genre}
                href={`/films/browse?genre=${encodeURIComponent(genre)}`}
                className="text-sm text-white px-4 py-2 rounded-full border border-cinema-border hover:border-cinema-gold hover:text-cinema-gold transition-colors"
              >
                {genre}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
