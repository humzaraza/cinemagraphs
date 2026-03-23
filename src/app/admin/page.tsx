import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import AdminFilmImport from '@/components/AdminFilmImport'
import AdminAnalyze from '@/components/AdminAnalyze'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const session = await getServerSession(authOptions)

  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin')
  }

  const [filmCount, reviewCount, graphCount] = await Promise.all([
    prisma.film.count(),
    prisma.review.count(),
    prisma.sentimentGraph.count(),
  ])

  const allFilms = await prisma.film.findMany({
    orderBy: { title: 'asc' },
    select: {
      id: true,
      title: true,
      tmdbId: true,
      status: true,
      isFeatured: true,
      createdAt: true,
      sentimentGraph: {
        select: { generatedAt: true },
      },
      _count: {
        select: { reviews: true },
      },
    },
  })

  const filmsForAnalyze = allFilms.map((film) => ({
    id: film.id,
    title: film.title,
    hasGraph: !!film.sentimentGraph,
    reviewCount: film._count.reviews,
    graphDate: film.sentimentGraph?.generatedAt
      ? film.sentimentGraph.generatedAt.toLocaleDateString()
      : null,
  }))

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <h1 className="font-[family-name:var(--font-playfair)] text-3xl font-bold mb-8 text-cinema-gold">
        Admin Dashboard
      </h1>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
        <div className="bg-cinema-card border border-cinema-border rounded-lg p-4">
          <p className="text-sm text-cinema-muted">Total Films</p>
          <p className="font-[family-name:var(--font-bebas)] text-3xl text-cinema-teal">
            {filmCount}
          </p>
        </div>
        <div className="bg-cinema-card border border-cinema-border rounded-lg p-4">
          <p className="text-sm text-cinema-muted">Total Reviews</p>
          <p className="font-[family-name:var(--font-bebas)] text-3xl text-cinema-teal">
            {reviewCount}
          </p>
        </div>
        <div className="bg-cinema-card border border-cinema-border rounded-lg p-4">
          <p className="text-sm text-cinema-muted">Sentiment Graphs</p>
          <p className="font-[family-name:var(--font-bebas)] text-3xl text-cinema-gold">
            {graphCount}
          </p>
        </div>
        <div className="bg-cinema-card border border-cinema-border rounded-lg p-4">
          <p className="text-sm text-cinema-muted">Pending Analysis</p>
          <p className="font-[family-name:var(--font-bebas)] text-3xl text-red-400">
            {filmCount - graphCount}
          </p>
        </div>
      </div>

      {/* Import Section */}
      <section className="mb-10">
        <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-4">
          Import from TMDB
        </h2>
        <AdminFilmImport />
      </section>

      {/* Sentiment Analysis Section */}
      <section className="mb-10">
        <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-4">
          Sentiment Analysis
        </h2>
        <AdminAnalyze films={filmsForAnalyze} />
      </section>
    </div>
  )
}
