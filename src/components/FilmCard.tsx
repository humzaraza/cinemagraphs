import Link from 'next/link'
import Image from 'next/image'
import { tmdbImageUrl, formatYear } from '@/lib/utils'
import { FilmCardMiniGraph } from './FilmCardMiniGraph'
import WatchlistButton from './WatchlistButton'
import type { MiniGraphDataPoint } from '@/lib/types'

interface FilmCardProps {
  id: string
  title: string
  posterUrl: string | null
  releaseDate: string | null
  genres: string[]
  sentimentScore?: number | null
  graphDataPoints?: MiniGraphDataPoint[] | null
  runtime?: number | null
}

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m}m`
  return `${h}h ${m.toString().padStart(2, '0')}m`
}

export default function FilmCard({
  id,
  title,
  posterUrl,
  releaseDate,
  genres,
  sentimentScore,
  graphDataPoints,
  runtime,
}: FilmCardProps) {
  return (
    <Link href={`/films/${id}`} className="group block">
      <div className="rounded-lg overflow-hidden bg-cinema-darker border border-cinema-border group-hover:border-cinema-gold/50 transition-all duration-300">
        {/* 1. Poster with score badge */}
        <div className="relative aspect-[2/3]">
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
              <span className="font-[family-name:var(--font-bebas)] text-lg text-cinema-gold">
                {sentimentScore.toFixed(1)}
              </span>
            </div>
          )}

          <div className="absolute top-2 left-2">
            <WatchlistButton filmId={id} size="sm" className="bg-cinema-dark/70 backdrop-blur-sm rounded p-1.5 hover:bg-cinema-dark/90" />
          </div>
        </div>

        {/* 2. Mini sentiment graph (or dashed placeholder) */}
        <div className="px-2 pt-2 pb-1" style={{ backgroundColor: '#13131f' }}>
          <FilmCardMiniGraph dataPoints={graphDataPoints ?? []} runtime={runtime ?? null} />
        </div>

        {/* 3. Title and metadata */}
        <div className="px-3 py-2.5" style={{ backgroundColor: '#13131f' }}>
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
