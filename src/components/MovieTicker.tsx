'use client'

import { useRef, useEffect } from 'react'
import Link from 'next/link'
import { AreaChart, Area, YAxis, ResponsiveContainer } from 'recharts'

interface TickerFilm {
  id: string
  title: string
  score: number
  dataPoints: { timeMidpoint: number; score: number }[]
}

export default function MovieTicker({ films }: { films: TickerFilm[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el || films.length === 0) return

    let animId: number
    let pos = 0
    const speed = 0.5 // px per frame

    const animate = () => {
      pos += speed
      // When we've scrolled past half the content (the duplicated set), reset
      if (pos >= el.scrollWidth / 2) pos = 0
      el.scrollLeft = pos
      animId = requestAnimationFrame(animate)
    }

    animId = requestAnimationFrame(animate)

    // Pause on hover
    const pause = () => cancelAnimationFrame(animId)
    const resume = () => { animId = requestAnimationFrame(animate) }
    el.addEventListener('mouseenter', pause)
    el.addEventListener('mouseleave', resume)

    return () => {
      cancelAnimationFrame(animId)
      el.removeEventListener('mouseenter', pause)
      el.removeEventListener('mouseleave', resume)
    }
  }, [films])

  if (films.length === 0) return null

  // Duplicate films for seamless loop
  const tickerFilms = [...films, ...films]

  return (
    <div className="border-b border-cinema-border bg-cinema-darker/90 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto flex items-center">
        {/* Static label */}
        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2 border-r border-cinema-border bg-cinema-darker z-10">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cinema-gold opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cinema-gold" />
          </span>
          <span className="font-[family-name:var(--font-bebas)] text-sm tracking-wider text-cinema-gold whitespace-nowrap">
            MOVIE MARKET
          </span>
        </div>

        {/* Scrolling films */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-hidden"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          <div className="flex">
            {tickerFilms.map((film, i) => (
              <Link
                key={`${film.id}-${i}`}
                href={`/films/${film.id}`}
                className="flex-shrink-0 flex items-center gap-3 px-4 py-2 border-r border-cinema-border/50 hover:bg-cinema-card/50 transition-colors"
              >
                <span className="text-xs text-cinema-cream whitespace-nowrap max-w-[120px] truncate">
                  {film.title}
                </span>
                {/* Mini sparkline */}
                <div className="w-16 h-6">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={film.dataPoints} margin={{ top: 1, right: 0, left: 0, bottom: 1 }}>
                      <defs>
                        <linearGradient id={`tickerGrad-${film.id}-${i}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={film.score >= 7 ? '#00E676' : '#E24B4A'} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={film.score >= 7 ? '#00E676' : '#E24B4A'} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <YAxis domain={[1, 10]} hide />
                      <Area
                        type="monotone"
                        dataKey="score"
                        stroke={film.score >= 7 ? '#00E676' : '#E24B4A'}
                        strokeWidth={1}
                        fill={`url(#tickerGrad-${film.id}-${i})`}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <span
                  className="font-[family-name:var(--font-bebas)] text-sm"
                  style={{ color: film.score >= 7 ? '#00E676' : '#E24B4A' }}
                >
                  {film.score.toFixed(1)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
