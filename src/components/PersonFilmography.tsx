'use client'

import Image from 'next/image'
import Link from 'next/link'
import { tmdbImageUrl } from '@/lib/utils'

interface SparklinePoint {
  percent: number
  score: number
}

const ROLE_LABELS: Record<string, string> = {
  DIRECTOR: 'Director',
  ACTOR: 'Actor',
  CINEMATOGRAPHER: 'Cinematographer',
  COMPOSER: 'Composer',
  EDITOR: 'Editor',
  WRITER: 'Writer',
  PRODUCER: 'Producer',
}

interface FilmEntry {
  filmId: string
  title: string
  posterUrl: string | null
  releaseDate: string | null
  role: string
  roles?: string[]
  character: string | null
  overallScore: number | null
  sparklineData: SparklinePoint[]
}

const SVG_W = 120
const SVG_H = 22
const PAD = 2

function scoreToY(score: number): number {
  // Fixed 0-10 scale
  return PAD + ((10 - score) / 10) * (SVG_H - PAD * 2)
}

function Sparkline({
  data,
  color,
}: {
  data: SparklinePoint[]
  color: string
}) {
  if (data.length < 2) return <div style={{ width: SVG_W, height: SVG_H }} />

  const points = data.map((d, i) => {
    const x = PAD + (i / (data.length - 1)) * (SVG_W - PAD * 2)
    const y = scoreToY(d.score)
    return { x, y }
  })

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const neutralY = scoreToY(5)

  return (
    <svg width={SVG_W} height={SVG_H} viewBox={`0 0 ${SVG_W} ${SVG_H}`}>
      <line
        x1={PAD}
        y1={neutralY}
        x2={SVG_W - PAD}
        y2={neutralY}
        stroke="#555"
        strokeWidth={0.6}
        strokeDasharray="3 2"
      />
      <path d={pathD} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function scoreColor(score: number): string {
  if (score >= 8) return 'text-[#2DD4A8]'
  if (score >= 6) return 'text-cinema-gold'
  return 'text-red-500'
}

export function PersonFilmography({ filmography }: { filmography: FilmEntry[] }) {
  if (filmography.length === 0) return null

  return (
    <div className="mt-8">
      <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-4">
        Filmography
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {filmography.map((film) => {
          const year = film.releaseDate
            ? new Date(film.releaseDate).getFullYear()
            : null
          const sparkColor = film.role === 'DIRECTOR' ? '#C8A951' : '#2DD4A8'

          return (
            <Link
              key={film.filmId}
              href={`/films/${film.filmId}`}
              className="flex items-center gap-3 rounded-lg border border-cinema-border bg-cinema-card p-3 hover:border-cinema-gold/50 transition-colors"
            >
              {/* Poster */}
              <div className="flex-shrink-0 w-[45px] h-[67px] relative rounded overflow-hidden bg-cinema-darker">
                {film.posterUrl ? (
                  <Image
                    src={tmdbImageUrl(film.posterUrl, 'w92')}
                    alt={film.title}
                    fill
                    unoptimized
                    className="object-cover"
                    sizes="45px"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-cinema-muted text-[9px]">
                    N/A
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-cinema-cream truncate">
                    {film.title}
                  </span>
                  {year && (
                    <span className="text-xs text-cinema-muted flex-shrink-0">{year}</span>
                  )}
                </div>
                {film.roles && film.roles.length > 1 && (
                  <p className="text-xs text-cinema-muted truncate mt-0.5">
                    {film.roles.map((r) => ROLE_LABELS[r] || r).join(', ')}
                  </p>
                )}
                {film.character && (!film.roles || film.roles.length <= 1) && (
                  <p className="text-xs text-cinema-muted truncate mt-0.5">
                    as {film.character}
                  </p>
                )}
                {film.sparklineData.length > 0 && (
                  <div className="mt-1">
                    <Sparkline data={film.sparklineData} color={sparkColor} />
                  </div>
                )}
              </div>

              {/* Score */}
              {film.overallScore !== null && (
                <div className="flex-shrink-0 text-right">
                  <span
                    className={`font-[family-name:var(--font-bebas)] text-lg ${scoreColor(film.overallScore)}`}
                  >
                    {film.overallScore.toFixed(1)}
                  </span>
                </div>
              )}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
