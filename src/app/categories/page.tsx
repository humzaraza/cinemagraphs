import { prisma } from '@/lib/prisma'
import Image from 'next/image'
import Link from 'next/link'
import { tmdbImageUrl } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export default async function CategoriesPage() {
  const films = await prisma.film.findMany({
    where: { status: 'ACTIVE' },
    select: { genres: true, posterUrl: true },
  })

  // Build genre → { count, posters[] }
  const genreMap = new Map<string, { count: number; posters: string[] }>()

  for (const film of films) {
    for (const genre of film.genres) {
      const entry = genreMap.get(genre) || { count: 0, posters: [] }
      entry.count++
      if (film.posterUrl && entry.posters.length < 4) {
        entry.posters.push(film.posterUrl)
      }
      genreMap.set(genre, entry)
    }
  }

  const genres = Array.from(genreMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, data]) => ({ name, ...data }))

  return (
    <div className="max-w-7xl mx-auto px-4 py-12">
      <h1 className="font-[family-name:var(--font-playfair)] text-3xl font-bold mb-3">
        Categories
      </h1>
      <p className="text-cinema-muted mb-10">
        Browse films by genre
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {genres.map((genre) => (
          <Link
            key={genre.name}
            href={`/films/browse?genre=${encodeURIComponent(genre.name)}`}
            className="group relative rounded-xl overflow-hidden border border-cinema-border hover:border-cinema-gold/50 transition-all h-48"
          >
            {/* Poster collage background */}
            <div className="absolute inset-0 flex">
              {genre.posters.map((path, i) => (
                <div
                  key={i}
                  className="relative flex-1 h-full"
                >
                  <Image
                    src={tmdbImageUrl(path, 'w300')}
                    alt=""
                    fill
                    unoptimized
                    sizes="(max-width: 640px) 25vw, 15vw"
                    className="object-cover"
                  />
                </div>
              ))}
              {genre.posters.length === 0 && (
                <div className="flex-1 bg-cinema-card" />
              )}
            </div>

            {/* Dark overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/60 to-black/40 group-hover:from-black/80 group-hover:via-black/50 transition-colors" />

            {/* Content */}
            <div className="relative h-full flex flex-col justify-end p-5">
              <h2 className="font-[family-name:var(--font-bebas)] text-3xl tracking-wide text-cinema-cream group-hover:text-cinema-gold transition-colors">
                {genre.name}
              </h2>
              <p className="text-sm text-cinema-muted mt-1">
                {genre.count} {genre.count === 1 ? 'film' : 'films'}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
