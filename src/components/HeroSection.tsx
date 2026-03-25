'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'

interface HeroFilm {
  id: string
  title: string
  releaseDate: string | null
  runtime: number | null
  director: string | null
  genres: string[]
  posterUrl: string | null
  backdropUrl: string | null
  sentimentScore: number
  dataPoints: {
    timeMidpoint: number
    timeStart: number
    timeEnd: number
    score: number
    label: string
    confidence: string
  }[]
}

function tmdbImageUrl(path: string | null, size: string = 'w500'): string {
  if (!path) return '/placeholder-poster.png'
  return `https://image.tmdb.org/t/p/${size}${path}`
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m}m`
  return `${h}h ${m.toString().padStart(2, '0')}m`
}

function scoreColor(score: number): string {
  if (score >= 8) return '#2DD4A8'
  if (score >= 6) return '#C8A951'
  return '#ef4444'
}

export default function HeroSection({ films }: { films: HeroFilm[] }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [isPaused, setIsPaused] = useState(false)

  const next = useCallback(() => {
    setActiveIndex((i) => (i + 1) % films.length)
  }, [films.length])

  const prev = useCallback(() => {
    setActiveIndex((i) => (i - 1 + films.length) % films.length)
  }, [films.length])

  // Auto-rotate every 8 seconds
  useEffect(() => {
    if (isPaused || films.length <= 1) return
    const timer = setInterval(next, 8000)
    return () => clearInterval(timer)
  }, [isPaused, next, films.length])

  if (films.length === 0) return null

  const film = films[activeIndex]
  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : null
  const chartData = film.dataPoints.map((dp) => ({
    ...dp,
    timeMidpoint: dp.timeMidpoint ?? Math.round((dp.timeStart + dp.timeEnd) / 2),
  }))

  return (
    <section
      className="relative overflow-hidden"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      {/* Backdrop image */}
      <div className="absolute inset-0">
        {film.backdropUrl && (
          <Image
            src={tmdbImageUrl(film.backdropUrl, 'w1280')}
            alt=""
            fill
            className="object-cover opacity-30"
            priority
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-cinema-dark via-cinema-dark/90 to-cinema-dark/70" />
        <div className="absolute inset-0 bg-gradient-to-t from-cinema-dark via-transparent to-cinema-dark/50" />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 py-12 md:py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
          {/* Left: Film info */}
          <div>
            <h1 className="font-[family-name:var(--font-playfair)] text-4xl md:text-5xl font-bold mb-3 text-cinema-cream">
              {film.title}
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-cinema-muted mb-4">
              {year && <span>{year}</span>}
              {film.runtime && <span>{formatTime(film.runtime)}</span>}
              {film.director && <span>Dir. {film.director}</span>}
            </div>
            {film.genres.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-5">
                {film.genres.slice(0, 4).map((g) => (
                  <span
                    key={g}
                    className="text-xs px-3 py-1 rounded-full bg-cinema-gold/10 text-cinema-gold border border-cinema-gold/20"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}

            {/* Cinemagraphs Score */}
            <div className="flex items-baseline gap-3 mb-6">
              <span className="text-xs text-cinema-muted uppercase tracking-wider">Cinemagraphs Score</span>
              <span
                className="font-[family-name:var(--font-bebas)] text-4xl"
                style={{ color: scoreColor(film.sentimentScore) }}
              >
                {film.sentimentScore.toFixed(1)}
              </span>
            </div>

            <div className="flex gap-3">
              <Link
                href={`/films/${film.id}`}
                className="bg-cinema-gold text-cinema-dark font-semibold px-6 py-2.5 rounded-lg hover:bg-cinema-gold/90 transition-colors text-sm"
              >
                View Full Graph
              </Link>
            </div>
          </div>

          {/* Right: Sentiment graph */}
          <div className="bg-cinema-darker/80 backdrop-blur-sm rounded-lg border border-cinema-border p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-cinema-muted uppercase tracking-wider">Sentiment Timeline</span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData} margin={{ top: 5, right: 30, left: 5, bottom: 5 }}>
                <defs>
                  <linearGradient id="heroGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#C8A951" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#C8A951" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3e" />
                <XAxis dataKey="timeMidpoint" tickFormatter={formatTime} stroke="#666" fontSize={10} />
                <YAxis domain={[1, 10]} ticks={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]} stroke="#666" fontSize={10} width={25} />
                <YAxis yAxisId="right" orientation="right" domain={[1, 10]} ticks={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]} stroke="#666" fontSize={10} width={25} />
                <Area yAxisId="right" type="monotone" dataKey="score" stroke="none" fill="none" dot={false} activeDot={false} isAnimationActive={false} />
                <ReferenceLine y={5} stroke="#666" strokeDasharray="6 4" />
                <Area
                  type="monotone"
                  dataKey="score"
                  stroke="#C8A951"
                  strokeWidth={2}
                  fill="url(#heroGradient)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
            {/* Story beat pills */}
            <div className="flex flex-wrap gap-1 mt-2">
              {film.dataPoints.slice(0, 8).map((dp, i) => (
                <span
                  key={i}
                  className="text-[9px] px-1.5 py-0.5 rounded-full border"
                  style={{
                    color: scoreColor(dp.score),
                    borderColor: scoreColor(dp.score) + '40',
                    backgroundColor: scoreColor(dp.score) + '10',
                  }}
                >
                  {dp.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Navigation */}
        {films.length > 1 && (
          <div className="flex items-center justify-center gap-4 mt-8">
            <button
              onClick={prev}
              className="w-8 h-8 flex items-center justify-center rounded-full border border-cinema-border hover:border-cinema-gold/50 text-cinema-muted hover:text-cinema-cream transition-colors"
              aria-label="Previous film"
            >
              &#8249;
            </button>
            <div className="flex gap-2">
              {films.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setActiveIndex(i)}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    i === activeIndex ? 'bg-cinema-gold' : 'bg-cinema-border hover:bg-cinema-muted'
                  }`}
                  aria-label={`Go to film ${i + 1}`}
                />
              ))}
            </div>
            <button
              onClick={next}
              className="w-8 h-8 flex items-center justify-center rounded-full border border-cinema-border hover:border-cinema-gold/50 text-cinema-muted hover:text-cinema-cream transition-colors"
              aria-label="Next film"
            >
              &#8250;
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
