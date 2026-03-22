import { prisma } from '@/lib/prisma'
import FilmCard from '@/components/FilmCard'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const [featuredFilms, recentFilms] = await Promise.all([
    prisma.film.findMany({
      where: { status: 'ACTIVE', isFeatured: true },
      include: { sentimentGraph: { select: { overallScore: true } } },
      take: 6,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.film.findMany({
      where: { status: 'ACTIVE' },
      include: { sentimentGraph: { select: { overallScore: true } } },
      take: 12,
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return (
    <div>
      {/* Hero */}
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

      {/* Featured Films */}
      {featuredFilms.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 py-12">
          <h2 className="font-[family-name:var(--font-playfair)] text-2xl font-bold mb-6 text-cinema-gold">
            Featured
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {featuredFilms.map((film) => (
              <FilmCard
                key={film.id}
                id={film.id}
                title={film.title}
                posterUrl={film.posterUrl}
                releaseDate={film.releaseDate?.toISOString() ?? null}
                genres={film.genres}
                sentimentScore={film.sentimentGraph?.overallScore}
              />
            ))}
          </div>
        </section>
      )}

      {/* Recent Films */}
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
