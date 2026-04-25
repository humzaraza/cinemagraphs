'use client'

import { useRef, useEffect } from 'react'
import Link from 'next/link'
import { AreaChart, Area, YAxis, ReferenceLine, ResponsiveContainer } from 'recharts'

interface TickerFilm {
  id: string
  title: string
  score: number
  previousScore: number | null
  delta: number | null
  dataPoints: { timeMidpoint: number; score: number }[]
}

export default function MovieTicker({ films }: { films: TickerFilm[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el || films.length === 0) return

    let animId: number
    let pos = 0
    const speed = 0.5

    const animate = () => {
      pos += speed
      if (pos >= el.scrollWidth / 2) pos = 0
      el.scrollLeft = pos
      animId = requestAnimationFrame(animate)
    }

    animId = requestAnimationFrame(animate)

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

  const tickerFilms = [...films, ...films]

  return (
    <div className="border-b border-cinema-border bg-cinema-darker/90 backdrop-blur-sm">
      <div className="flex items-center">
        {/* Static label */}
        <div className="flex-shrink-0 flex items-center gap-2 md:gap-3 px-3 py-4 md:px-8 md:py-7 border-r border-cinema-border bg-cinema-darker z-10">
          <span className="relative flex h-2.5 w-2.5 md:h-3.5 md:w-3.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cinema-gold opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 md:h-3.5 md:w-3.5 bg-cinema-gold" />
          </span>
          <span className="font-[family-name:var(--font-bebas)] text-base md:text-xl tracking-wider text-cinema-gold whitespace-nowrap">
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
            {tickerFilms.map((film, i) => {
              const d = film.delta
              const prev = film.previousScore
              const hasDelta = d != null && prev != null

              // Derive trend from dataPoints as fallback when no previousScore
              const pts = film.dataPoints
              const dpTrend = pts.length >= 2
                ? pts[pts.length - 1].score - pts[0].score
                : 0

              const effectiveDelta = hasDelta ? d : dpTrend
              const isUp = effectiveDelta > 0
              const isDown = effectiveDelta < 0
              const color = isUp ? 'var(--cinema-teal)' : isDown ? '#ef4444' : 'var(--cinema-gold)'

              return (
                <Link
                  key={`${film.id}-${i}`}
                  href={`/films/${film.id}`}
                  className="flex-shrink-0 flex items-center gap-2 md:gap-4 px-3 py-4 md:px-6 md:py-7 border-r border-cinema-border/50 hover:bg-cinema-card/50 transition-colors"
                >
                  <span className="text-sm md:text-base font-medium text-cinema-cream whitespace-nowrap max-w-[110px] md:max-w-[180px] truncate">
                    {film.title}
                  </span>
                  {/* Mini sparkline — sentiment curve colored by score direction */}
                  <div className="w-16 h-9 md:w-32 md:h-14">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={film.dataPoints} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
                        <defs>
                          <linearGradient id={`tickerGrad-${film.id}-${i}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={color} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <YAxis domain={[0, 10]} hide />
                        <ReferenceLine y={5.0} stroke="#888" strokeDasharray="3 3" strokeWidth={0.5} />
                        <Area
                          type="monotone"
                          dataKey="score"
                          stroke={color}
                          strokeWidth={1.5}
                          fill={`url(#tickerGrad-${film.id}-${i})`}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <span
                    className="font-[family-name:var(--font-bebas)] text-base md:text-xl"
                    style={{ color }}
                  >
                    {film.score.toFixed(1)}
                  </span>
                  {hasDelta && d !== 0 && (
                    <span className="text-sm font-medium" style={{ color }}>
                      {isUp ? '\u25B2' : '\u25BC'} {isUp ? '+' : ''}{d!.toFixed(1)}
                    </span>
                  )}
                  {!hasDelta && dpTrend !== 0 && (
                    <span className="text-sm font-medium" style={{ color }}>
                      {isUp ? '\u25B2' : '\u25BC'}
                    </span>
                  )}
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
