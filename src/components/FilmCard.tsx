import Link from 'next/link'
import Image from 'next/image'
import { tmdbImageUrl, formatYear } from '@/lib/utils'

interface FilmCardProps {
  id: string
  title: string
  posterUrl: string | null
  releaseDate: string | null
  genres: string[]
  sentimentScore?: number | null
}

export default function FilmCard({
  id,
  title,
  posterUrl,
  releaseDate,
  genres,
  sentimentScore,
}: FilmCardProps) {
  return (
    <Link href={`/films/${id}`} className="group block">
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-cinema-darker border border-cinema-border group-hover:border-cinema-gold/50 transition-all duration-300">
        {posterUrl ? (
          <Image
            src={tmdbImageUrl(posterUrl, 'w500')}
            alt={title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-cinema-muted">
            No Poster
          </div>
        )}

        {sentimentScore != null && (
          <div className="absolute top-2 right-2 bg-cinema-dark/90 backdrop-blur-sm rounded px-2 py-1">
            <span className="font-[family-name:var(--font-bebas)] text-lg text-cinema-teal">
              {sentimentScore.toFixed(1)}
            </span>
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-cinema-dark via-cinema-dark/80 to-transparent p-3 pt-8">
          <h3 className="font-[family-name:var(--font-playfair)] text-sm font-semibold leading-tight text-white">
            {title}
          </h3>
          <div className="flex items-center gap-2 mt-1">
            {releaseDate && (
              <span className="text-xs text-cinema-muted">
                {formatYear(releaseDate)}
              </span>
            )}
            {genres.length > 0 && (
              <span className="text-xs text-cinema-gold/70">
                {genres.slice(0, 2).join(' / ')}
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  )
}
