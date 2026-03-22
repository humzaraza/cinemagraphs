import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import AdminFilmImport from '@/components/AdminFilmImport'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const session = await getServerSession(authOptions)

  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin')
  }

  const [filmCount, reviewCount] = await Promise.all([
    prisma.film.count(),
    prisma.review.count(),
  ])

  const recentFilms = await prisma.film.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      title: true,
      tmdbId: true,
      status: true,
      isFeatured: true,
      createdAt: true,
    },
  })

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <h1 className="font-[family-name:var(--font-playfair)] text-3xl font-bold mb-8 text-cinema-gold">
        Admin Dashboard
      </h1>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-10">
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
      </div>

      {/* Import Section */}
      <section className="mb-10">
        <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-4">
          Import from TMDB
        </h2>
        <AdminFilmImport />
      </section>

      {/* Recent Films */}
      <section>
        <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-4">
          Recent Films
        </h2>
        {recentFilms.length === 0 ? (
          <p className="text-cinema-muted">No films imported yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cinema-border text-left text-cinema-muted">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">TMDB ID</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Featured</th>
                  <th className="py-2">Added</th>
                </tr>
              </thead>
              <tbody>
                {recentFilms.map((film) => (
                  <tr key={film.id} className="border-b border-cinema-border/50">
                    <td className="py-2 pr-4 text-cinema-cream">{film.title}</td>
                    <td className="py-2 pr-4 text-cinema-muted">{film.tmdbId}</td>
                    <td className="py-2 pr-4">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          film.status === 'ACTIVE'
                            ? 'bg-cinema-teal/10 text-cinema-teal'
                            : 'bg-cinema-muted/10 text-cinema-muted'
                        }`}
                      >
                        {film.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-cinema-muted">
                      {film.isFeatured ? 'Yes' : 'No'}
                    </td>
                    <td className="py-2 text-cinema-muted">
                      {film.createdAt.toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
