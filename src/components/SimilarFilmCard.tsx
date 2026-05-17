import Link from 'next/link'
import Image from 'next/image'
import { tmdbImageUrl } from '@/lib/utils'

export interface SimilarFilmCardProps {
  id: string
  title: string
  year: number | null
  posterUrl: string | null
  score: number | null
  userHasReviewed: boolean
}

export default function SimilarFilmCard({
  id,
  title,
  year,
  posterUrl,
  score,
  userHasReviewed,
}: SimilarFilmCardProps) {
  return (
    <Link
      href={`/films/${id}`}
      className="group block flex-shrink-0 w-36 snap-start sm:w-auto sm:flex-shrink"
    >
      <div className="rounded-lg overflow-hidden bg-cinema-darker border border-cinema-border group-hover:border-cinema-gold/50 transition-all duration-300">
        <div className="relative aspect-[2/3]">
          {posterUrl ? (
            <Image
              src={tmdbImageUrl(posterUrl, 'w500')}
              alt={title}
              fill
              unoptimized
              className="object-cover group-hover:scale-105 transition-transform duration-500"
              sizes="(max-width: 640px) 144px, (max-width: 1024px) 33vw, 20vw"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-cinema-muted text-xs">
              No Poster
            </div>
          )}

          {userHasReviewed && (
            <div
              data-testid="reviewed-badge"
              aria-label="You have reviewed this film"
              className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-cinema-gold px-2 py-0.5 text-[10px] font-semibold tracking-wider text-cinema-dark shadow-sm"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 12 12"
                className="h-2.5 w-2.5 fill-current"
              >
                <path d="M10.28 3.22a.75.75 0 0 1 0 1.06l-5 5a.75.75 0 0 1-1.06 0l-2.5-2.5a.75.75 0 1 1 1.06-1.06L4.75 7.69l4.47-4.47a.75.75 0 0 1 1.06 0Z" />
              </svg>
              REVIEWED
            </div>
          )}
        </div>

        <div className="px-3 py-2.5" style={{ backgroundColor: '#13131f' }}>
          <h3 className="font-[family-name:var(--font-playfair)] text-sm font-semibold leading-tight text-white truncate">
            {title}
          </h3>
          {(year !== null || score !== null) && (
            <div className="flex items-center gap-2 mt-1">
              {year !== null && <span className="text-xs text-cinema-muted">{year}</span>}
              {score !== null && (
                <span className="font-[family-name:var(--font-bebas)] text-base leading-none text-cinema-gold">
                  {score.toFixed(1)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </Link>
  )
}
