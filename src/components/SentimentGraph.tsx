'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceDot,
} from 'recharts'
import type { SentimentDataPoint, PeakLowMoment } from '@/lib/types'

// ── Types ───────────────────────────────────────────────

type GraphView = 'critics' | 'audience' | 'both' | 'merged'

interface AudienceData {
  userReviewCount: number
  beatAverages: Record<string, number>
  liveSessionCount: number
  reactionScores: { index: number; score: number }[]
}

interface SentimentGraphProps {
  dataPoints: SentimentDataPoint[]
  overallScore: number
  anchoredFrom?: string | null
  peakMoment?: PeakLowMoment | null
  lowestMoment?: PeakLowMoment | null
  biggestSwing?: string | null
  summary?: string | null
  sourcesUsed?: string[]
  reviewCount?: number
  runtime?: number | null
  filmId?: string
  generatedAt?: string | null
}

// ── Helpers ─────────────────────────────────────────────

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m}m`
  return `${h}h ${m.toString().padStart(2, '0')}m`
}

function scoreColor(score: number): string {
  if (score >= 8) return 'var(--cinema-teal)'
  if (score >= 6) return 'var(--cinema-gold)'
  return '#ef4444'
}

function confidenceRadius(confidence: string): number {
  if (confidence === 'high') return 8
  if (confidence === 'medium') return 6
  return 4
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function getMergedWeights(reviewCount: number, sessionCount: number) {
  if (reviewCount === 0 && sessionCount < 20) {
    return { external: 1, audience: 0, reaction: 0 }
  }

  let ext: number
  let aud: number

  if (reviewCount >= 5) {
    ext = 0.4
    aud = 0.6
  } else if (reviewCount >= 1) {
    ext = 0.6
    aud = 0.4
  } else {
    ext = 1
    aud = 0
  }

  let react = 0
  if (sessionCount >= 20) {
    react = 0.2
    ext *= 0.8
    aud *= 0.8
  }

  return { external: ext, audience: aud, reaction: react }
}

// ── Tooltip ─────────────────────────────────────────────

function CustomTooltip({
  active,
  payload,
  spoilersRevealed,
  graphView,
}: {
  active?: boolean
  payload?: any[]
  spoilersRevealed?: boolean
  graphView?: GraphView
}) {
  if (!active || !payload?.length) return null
  const data = payload[0].payload
  const showSpoilers = spoilersRevealed === true
  const view = graphView ?? 'critics'

  return (
    <div className="bg-cinema-card border border-cinema-border rounded-lg p-3 max-w-xs shadow-xl">
      {showSpoilers && data.label && (
        <span className="text-cinema-cream font-semibold text-sm block mb-1.5">
          {data.labelFull ?? data.label}
        </span>
      )}

      {/* Critics score */}
      {(view === 'critics' || view === 'both') && (
        <div className="flex items-center gap-2 mb-1">
          <span className="w-3 h-[2px] rounded bg-cinema-gold inline-block" />
          <span className="text-xs text-cinema-muted">Critics:</span>
          <span
            className="font-[family-name:var(--font-bebas)] text-lg"
            style={{ color: scoreColor(data.score) }}
          >
            {data.score.toFixed(1)}
          </span>
        </div>
      )}

      {/* Audience score */}
      {(view === 'audience' || view === 'both') && data.userScore != null && (
        <div className="flex items-center gap-2 mb-1">
          <span className="w-3 h-[2px] rounded bg-cinema-teal inline-block" />
          <span className="text-xs text-cinema-muted">Audience:</span>
          <span className="font-[family-name:var(--font-bebas)] text-lg text-cinema-teal">
            {data.userScore.toFixed(1)}
          </span>
        </div>
      )}

      {/* Audience-only fallback when no data at this beat */}
      {view === 'audience' && data.userScore == null && (
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-cinema-muted/50 italic">No audience data for this beat</span>
        </div>
      )}

      {/* Merged score */}
      {view === 'merged' && data.mergedScore != null && (
        <div className="flex items-center gap-2 mb-1">
          <span className="w-3 h-[2px] rounded bg-[#F5F0E8] inline-block" />
          <span className="text-xs text-cinema-muted">Merged:</span>
          <span className="font-[family-name:var(--font-bebas)] text-lg" style={{ color: '#F5F0E8' }}>
            {data.mergedScore.toFixed(1)}
          </span>
        </div>
      )}

      <div className="text-xs text-cinema-muted mb-1">
        {formatTime(data.timeStart)} – {formatTime(data.timeEnd)}
      </div>

      {(view === 'critics' || view === 'both' || view === 'merged') && data.confidence && (
        <div className="flex items-center gap-1 mb-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{
              backgroundColor:
                data.confidence === 'high' ? 'var(--cinema-teal)' : data.confidence === 'medium' ? 'var(--cinema-gold)' : '#666',
            }}
          />
          <span className="text-xs text-cinema-muted capitalize">{data.confidence} confidence</span>
        </div>
      )}

      {showSpoilers && data.reviewEvidence && (
        <p className="text-xs text-cinema-cream/70 italic leading-relaxed">{data.reviewEvidence}</p>
      )}
    </div>
  )
}

// ── Main Component ──────────────────────────────────────

export default function SentimentGraph({
  dataPoints,
  overallScore,
  anchoredFrom,
  peakMoment,
  lowestMoment,
  biggestSwing,
  summary,
  sourcesUsed,
  reviewCount,
  runtime,
  filmId,
  generatedAt,
}: SentimentGraphProps) {
  const [graphView, setGraphView] = useState<GraphView>('critics')
  const [audienceData, setAudienceData] = useState<AudienceData | null>(null)
  const [audienceLoaded, setAudienceLoaded] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [spoilersRevealed, setSpoilersRevealed] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  // Mobile detection
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Spoiler state from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('cinemagraphs-spoilers')
    if (stored === 'true') setSpoilersRevealed(true)
  }, [])

  // Fetch audience data (user reviews + live reactions)
  const fetchAudienceData = useCallback(async () => {
    if (!filmId) {
      setAudienceLoaded(true)
      return
    }
    try {
      const res = await fetch(`/api/films/${filmId}/audience-data`)
      if (!res.ok) {
        setAudienceLoaded(true)
        return
      }
      const data: AudienceData = await res.json()
      setAudienceData(data)

      // Set default view: "Both" if audience data exists, "Critics" if not
      const hasData = Object.keys(data.beatAverages).length > 0 || data.liveSessionCount >= 20
      if (hasData) {
        setGraphView('both')
      }
    } catch {
      // silently fail
    } finally {
      setAudienceLoaded(true)
    }
  }, [filmId])

  useEffect(() => {
    fetchAudienceData()
  }, [fetchAudienceData])

  function toggleSpoilers() {
    const next = !spoilersRevealed
    setSpoilersRevealed(next)
    localStorage.setItem('cinemagraphs-spoilers', String(next))
  }

  // ── Empty state ──
  if (!dataPoints || dataPoints.length === 0) {
    return (
      <div className="space-y-6">
        <div className="bg-cinema-darker rounded-lg border border-cinema-border p-4 md:p-6">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-[family-name:var(--font-playfair)] text-lg text-cinema-cream">
              Audience Sentiment
            </h3>
          </div>
          <div className="relative" style={{ height: 320 }}>
            <svg className="w-full h-full" preserveAspectRatio="none">
              <line
                x1="5%"
                y1="50%"
                x2="95%"
                y2="50%"
                stroke="#555"
                strokeWidth={1.5}
                strokeDasharray="8 6"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <p className="text-cinema-muted text-sm text-center max-w-md leading-relaxed">
                Not enough reviews yet — we&apos;re waiting for more data to build this film&apos;s sentiment timeline
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Audience data computed values ──
  const hasAudienceData = audienceData != null && (
    Object.keys(audienceData.beatAverages).length > 0 || audienceData.liveSessionCount >= 20
  )

  const mergedWeights = audienceData
    ? getMergedWeights(audienceData.userReviewCount, audienceData.liveSessionCount)
    : { external: 1, audience: 0, reaction: 0 }

  // Reaction score lookup by data point index
  const reactionLookup: Record<number, number> = {}
  if (audienceData?.reactionScores) {
    for (const rs of audienceData.reactionScores) {
      reactionLookup[rs.index] = rs.score
    }
  }

  // ── Chart data ──
  const realData = dataPoints.map((dp, i) => {
    const timeMidpoint = dp.timeMidpoint ?? Math.round((dp.timeStart + dp.timeEnd) / 2)
    const userScore = audienceData?.beatAverages[dp.label] ?? null

    // Compute merged score
    let mergedScore: number | null = null
    if (hasAudienceData) {
      const audScore = userScore ?? dp.score // fallback to critics if no audience data for this beat
      mergedScore = dp.score * mergedWeights.external + audScore * mergedWeights.audience
      if (reactionLookup[i] !== undefined) {
        mergedScore += reactionLookup[i] * mergedWeights.reaction
      }
      mergedScore = Math.max(1, Math.min(10, Math.round(mergedScore * 10) / 10))
    }

    return {
      ...dp,
      timeMidpoint,
      fill: scoreColor(dp.score),
      userScore,
      mergedScore,
    }
  })

  // Computed overall scores for header display
  const audienceOverall = hasAudienceData
    ? (() => {
        const scores = realData.filter(dp => dp.userScore != null).map(dp => dp.userScore!)
        return scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null
      })()
    : null

  const mergedOverall = hasAudienceData
    ? (() => {
        const scores = realData.filter(dp => dp.mergedScore != null).map(dp => dp.mergedScore!)
        return scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null
      })()
    : null

  const sectionTitle =
    graphView === 'audience' && hasAudienceData ? 'Audience Sentiment'
    : graphView === 'both' && hasAudienceData ? 'Critics + Audience Sentiment'
    : graphView === 'merged' && hasAudienceData ? 'Merged Sentiment'
    : 'Critics Sentiment'

  // Prepend synthetic neutral starting point
  const chartData = [
    {
      timeMidpoint: 0,
      timeStart: 0,
      timeEnd: 0,
      score: 5,
      label: '',
      confidence: 'low' as const,
      reviewEvidence: '',
      fill: scoreColor(5),
      userScore: hasAudienceData ? 5 : null,
      mergedScore: hasAudienceData ? 5 : null,
    } as (typeof realData)[0],
    ...realData,
  ]

  // ── Visibility flags ──
  const showCritics = graphView === 'critics' || graphView === 'both'
  const showAudience = (graphView === 'audience' || graphView === 'both') && hasAudienceData
  const showMerged = graphView === 'merged' && hasAudienceData

  // ── Toggle options ──
  const toggleOptions: { value: GraphView; label: string; disabled: boolean; color: string }[] = [
    { value: 'critics', label: 'Critics', disabled: false, color: 'var(--cinema-gold)' },
    { value: 'audience', label: 'Audience', disabled: !hasAudienceData, color: 'var(--cinema-teal)' },
    { value: 'both', label: 'Both', disabled: !hasAudienceData, color: 'var(--cinema-gold)' },
    { value: 'merged', label: 'Merged', disabled: !hasAudienceData, color: '#F5F0E8' },
  ]

  // Score for beat pills — corresponds to visible line(s)
  const getPillScore = (dp: (typeof chartData)[0]) => {
    if (graphView === 'audience') return dp.userScore
    if (graphView === 'merged') return dp.mergedScore
    return dp.score // critics or both
  }

  return (
    <div className="space-y-6">
      {/* Main Graph */}
      <div className="bg-cinema-darker rounded-lg border border-cinema-border p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-[family-name:var(--font-playfair)] text-lg text-cinema-cream">
            {sectionTitle}
          </h3>
          {graphView === 'both' && hasAudienceData ? (
            <div className="flex flex-col items-end gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-cinema-muted">Critics</span>
                <span
                  className="font-[family-name:var(--font-bebas)] text-3xl"
                  style={{ color: 'var(--cinema-gold)' }}
                >
                  {overallScore.toFixed(1)}
                </span>
              </div>
              {audienceOverall != null && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-cinema-muted">Audience</span>
                  <span
                    className="font-[family-name:var(--font-bebas)] text-3xl"
                    style={{ color: 'var(--cinema-teal)' }}
                  >
                    {audienceOverall.toFixed(1)}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-cinema-muted">
                {graphView === 'audience' && hasAudienceData ? 'Audience'
                  : graphView === 'merged' && hasAudienceData ? 'Merged'
                  : 'Critics'}
              </span>
              <span
                className="font-[family-name:var(--font-bebas)] text-3xl"
                style={{
                  color: graphView === 'audience' && hasAudienceData ? 'var(--cinema-teal)'
                    : graphView === 'merged' && hasAudienceData ? '#F5F0E1'
                    : 'var(--cinema-gold)',
                }}
              >
                {graphView === 'audience' && hasAudienceData && audienceOverall != null
                  ? audienceOverall.toFixed(1)
                  : graphView === 'merged' && hasAudienceData && mergedOverall != null
                    ? mergedOverall.toFixed(1)
                    : overallScore.toFixed(1)}
              </span>
            </div>
          )}
        </div>

        {/* Toggle Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="inline-flex items-center gap-1 bg-cinema-dark/60 rounded-full p-1 border border-cinema-border">
            {toggleOptions.map((opt) => {
              const isActive = graphView === opt.value
              return (
                <button
                  key={opt.value}
                  disabled={opt.disabled}
                  onClick={() => !opt.disabled && setGraphView(opt.value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                    opt.disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                  }`}
                  style={
                    isActive
                      ? {
                          backgroundColor: opt.color + '20',
                          color: opt.color,
                          boxShadow: `inset 0 0 0 1px ${opt.color}40`,
                        }
                      : opt.disabled
                        ? { color: 'rgba(102,102,102,0.3)' }
                        : { color: '#888' }
                  }
                  onMouseEnter={(e) => {
                    if (!opt.disabled && !isActive) {
                      e.currentTarget.style.color = '#ccc'
                      e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!opt.disabled && !isActive) {
                      e.currentTarget.style.color = '#888'
                      e.currentTarget.style.backgroundColor = 'transparent'
                    }
                  }}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>

          {/* No audience data message */}
          {audienceLoaded && !hasAudienceData && (
            <span className="text-xs text-cinema-muted/60">
              No audience data yet —{' '}
              <button
                type="button"
                onClick={() => {
                  document.getElementById('community-tabs')?.scrollIntoView({ behavior: 'smooth' })
                }}
                className="text-cinema-gold/70 hover:text-cinema-gold underline transition-colors"
              >
                be the first to review
              </button>
            </span>
          )}
        </div>

        {/* Chart */}
        <ResponsiveContainer width="100%" height={isMobile ? 420 : 320}>
          <AreaChart data={chartData} margin={{ top: 10, right: isMobile ? 25 : 35, left: isMobile ? 5 : 10, bottom: 30 }}>
            <defs>
              <linearGradient id="sentimentGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--cinema-gold)" stopOpacity={0.3} />
                <stop offset="50%" stopColor="var(--cinema-gold)" stopOpacity={0.1} />
                <stop offset="95%" stopColor="var(--cinema-gold)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="userGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--cinema-teal)" stopOpacity={0.2} />
                <stop offset="95%" stopColor="var(--cinema-teal)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="mergedGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#F5F0E8" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#F5F0E8" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--cinema-border)" />
            <XAxis
              dataKey="timeMidpoint"
              tickFormatter={formatTime}
              stroke="#666"
              fontSize={isMobile ? 10 : 11}
              interval={isMobile ? 2 : 0}
              label={
                isMobile
                  ? undefined
                  : {
                      value: runtime ? `Runtime: ${formatTime(runtime)}` : '',
                      position: 'bottom',
                      offset: 10,
                      fill: '#666',
                      fontSize: 11,
                    }
              }
            />
            {/* Left Y-axis */}
            <YAxis
              domain={[1, 10]}
              ticks={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}
              stroke="#666"
              fontSize={11}
              width={30}
            />
            {/* Right Y-axis (mirror) */}
            <YAxis
              yAxisId="right"
              orientation="right"
              domain={[1, 10]}
              ticks={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}
              stroke="#666"
              fontSize={11}
              width={30}
            />
            {/* Invisible area to bind right Y-axis */}
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="score"
              stroke="none"
              fill="none"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />

            <Tooltip
              content={<CustomTooltip spoilersRevealed={spoilersRevealed} graphView={graphView} />}
              cursor={{ stroke: 'var(--cinema-gold)', strokeOpacity: 0.3, strokeDasharray: '4 4' }}
            />

            {/* Neutral reference line */}
            <ReferenceLine y={5} stroke="#666" strokeDasharray="6 4" />

            {/* ── Critics line (Gold, solid) ── */}
            {showCritics && (
              <Area
                type="monotone"
                dataKey="score"
                stroke="var(--cinema-gold)"
                strokeWidth={2.5}
                fill="url(#sentimentGradient)"
                isAnimationActive={false}
                dot={(props: any) => {
                  const { cx, cy, payload, index } = props
                  if (cx == null || cy == null) return <circle r={0} />
                  // Skip dot on the anchored 5.0 starting point
                  if (index === 0) return <circle key={`dot-${index}`} r={0} />
                  const isHighlighted = highlightedIndex === index
                  const baseR = confidenceRadius(payload.confidence)
                  const r = isHighlighted ? baseR + 4 : baseR
                  const color = scoreColor(payload.score)
                  return (
                    <g key={`dot-${index}`}>
                      {isHighlighted && (
                        <circle
                          cx={cx}
                          cy={cy}
                          r={r + 4}
                          fill="none"
                          stroke="#fff"
                          strokeWidth={2}
                          opacity={0.6}
                        >
                          <animate
                            attributeName="r"
                            from={String(r + 2)}
                            to={String(r + 6)}
                            dur="1s"
                            repeatCount="indefinite"
                          />
                          <animate
                            attributeName="opacity"
                            from="0.6"
                            to="0"
                            dur="1s"
                            repeatCount="indefinite"
                          />
                        </circle>
                      )}
                      <circle
                        cx={cx}
                        cy={cy}
                        r={r}
                        fill={color}
                        stroke={isHighlighted ? '#fff' : 'var(--cinema-card)'}
                        strokeWidth={isHighlighted ? 3 : 2}
                        style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
                      />
                    </g>
                  )
                }}
                activeDot={(props: any) => {
                  const { cx, cy, payload, index } = props
                  if (cx == null || cy == null) return <circle r={0} />
                  if (index === 0) return <circle r={0} />
                  const r = confidenceRadius(payload.confidence) + 3
                  const color = scoreColor(payload.score)
                  return (
                    <circle
                      key={`activedot-${index}`}
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill={color}
                      stroke="var(--cinema-cream)"
                      strokeWidth={2}
                      style={{ cursor: 'pointer' }}
                    />
                  )
                }}
              />
            )}

            {/* Peak moment (shown with critics line) */}
            {showCritics && peakMoment && (
              <ReferenceDot
                x={peakMoment.time}
                y={peakMoment.score}
                r={8}
                fill="var(--cinema-teal)"
                stroke="var(--cinema-cream)"
                strokeWidth={2}
              />
            )}

            {/* Lowest moment (shown with critics line, skip if it falls on the anchored 5.0 start) */}
            {showCritics && lowestMoment && lowestMoment.time !== dataPoints[0]?.timeMidpoint && (
              <ReferenceDot
                x={lowestMoment.time}
                y={lowestMoment.score}
                r={8}
                fill="#ef4444"
                stroke="var(--cinema-cream)"
                strokeWidth={2}
              />
            )}

            {/* ── Audience line (Teal, solid) ── */}
            {showAudience && (
              <Area
                type="monotone"
                dataKey="userScore"
                stroke="var(--cinema-teal)"
                strokeWidth={2}
                fill="url(#userGradient)"
                isAnimationActive={false}
                connectNulls
                dot={(props: any) => {
                  const { cx, cy, payload, index } = props
                  if (cx == null || cy == null || payload.userScore == null) return <circle r={0} />
                  return (
                    <circle
                      key={`user-dot-${index}`}
                      cx={cx}
                      cy={cy}
                      r={4}
                      fill="var(--cinema-teal)"
                      stroke="var(--cinema-card)"
                      strokeWidth={1.5}
                    />
                  )
                }}
                activeDot={(props: any) => {
                  const { cx, cy, index } = props
                  if (cx == null || cy == null) return <circle r={0} />
                  return (
                    <circle
                      key={`user-activedot-${index}`}
                      cx={cx}
                      cy={cy}
                      r={6}
                      fill="var(--cinema-teal)"
                      stroke="var(--cinema-cream)"
                      strokeWidth={2}
                    />
                  )
                }}
              />
            )}

            {/* ── Merged line (Ivory, solid) ── */}
            {showMerged && (
              <Area
                type="monotone"
                dataKey="mergedScore"
                stroke="rgba(245,240,232,0.9)"
                strokeWidth={2.5}
                fill="url(#mergedGradient)"
                isAnimationActive={false}
                connectNulls
                dot={(props: any) => {
                  const { cx, cy, payload, index } = props
                  if (cx == null || cy == null || payload.mergedScore == null) return <circle r={0} />
                  return (
                    <circle
                      key={`merged-dot-${index}`}
                      cx={cx}
                      cy={cy}
                      r={5}
                      fill="#F5F0E8"
                      stroke="var(--cinema-card)"
                      strokeWidth={1.5}
                    />
                  )
                }}
                activeDot={(props: any) => {
                  const { cx, cy, index } = props
                  if (cx == null || cy == null) return <circle r={0} />
                  return (
                    <circle
                      key={`merged-activedot-${index}`}
                      cx={cx}
                      cy={cy}
                      r={7}
                      fill="#F5F0E8"
                      stroke="var(--cinema-card)"
                      strokeWidth={2}
                    />
                  )
                }}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>

        {/* Scale labels */}
        <div className="flex justify-between text-[10px] text-cinema-muted/60 mt-1 px-4 md:px-8">
          <span>1 — Hated it</span>
          <span>5 — Neutral</span>
          <span>10 — Masterpiece</span>
        </div>

        {/* Story beat pills with spoiler protection */}
        <div className="mt-3 md:mt-4">
          <div className="flex justify-center mb-2 md:mb-3">
            <button
              type="button"
              onClick={toggleSpoilers}
              className="inline-flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-1.5 md:py-2 rounded-md border text-xs md:text-sm font-medium transition-all duration-200"
              style={{
                borderColor: 'var(--cinema-gold)',
                color: spoilersRevealed ? 'var(--cinema-card)' : 'var(--cinema-gold)',
                backgroundColor: spoilersRevealed ? 'var(--cinema-gold)' : 'transparent',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--cinema-gold)'
                e.currentTarget.style.color = 'var(--cinema-card)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = spoilersRevealed ? 'var(--cinema-gold)' : 'transparent'
                e.currentTarget.style.color = spoilersRevealed ? 'var(--cinema-card)' : 'var(--cinema-gold)'
              }}
            >
              {spoilersRevealed ? (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18"
                    />
                  </svg>
                  Hide Spoilers
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                    />
                  </svg>
                  Reveal Spoilers
                </>
              )}
            </button>
          </div>
          <div
            className="flex gap-1.5 transition-all duration-300 overflow-x-auto md:flex-wrap md:overflow-x-visible pb-2 md:pb-0"
            style={{
              filter: spoilersRevealed ? 'none' : 'blur(4px)',
              opacity: spoilersRevealed ? 1 : 0.6,
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
            }}
          >
            {chartData.slice(1).map((dp, i) => {
              const chartIndex = i + 1
              const pillScore = getPillScore(dp)
              if (pillScore == null) return null
              const color = scoreColor(pillScore)
              const isActive = highlightedIndex === chartIndex
              return (
                <button
                  key={i}
                  type="button"
                  className="text-[10px] px-2 py-0.5 rounded-full border transition-all duration-200 flex-shrink-0 md:flex-shrink whitespace-normal"
                  title={dp.labelFull ?? dp.label}
                  style={{
                    color: isActive ? 'var(--cinema-card)' : color,
                    borderColor: isActive ? color : color + '40',
                    backgroundColor: isActive ? color : color + '10',
                    transform: isActive ? 'scale(1.1)' : 'scale(1)',
                    boxShadow: isActive ? `0 0 8px ${color}60` : 'none',
                  }}
                  onMouseEnter={() => (spoilersRevealed ? setHighlightedIndex(chartIndex) : undefined)}
                  onMouseLeave={() => (spoilersRevealed ? setHighlightedIndex(null) : undefined)}
                  onClick={() =>
                    spoilersRevealed
                      ? setHighlightedIndex(highlightedIndex === chartIndex ? null : chartIndex)
                      : toggleSpoilers()
                  }
                >
                  <span className="md:hidden">{dp.label}</span>
                  <span className="hidden md:inline">{dp.labelFull ?? dp.label}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Dynamic Legend */}
        <div className="flex flex-wrap items-center justify-between mt-4 text-xs text-cinema-muted">
          <div className="flex flex-wrap items-center gap-4">
            {/* Line labels — only for visible lines */}
            {showCritics && (
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-[2px] rounded bg-cinema-gold inline-block" />
                <span>Critics</span>
              </div>
            )}
            {showAudience && (
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-[2px] rounded bg-cinema-teal inline-block" />
                <span>Audience</span>
              </div>
            )}
            {showMerged && (
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-[2px] rounded bg-[#F5F0E8] inline-block" />
                <span>Merged</span>
              </div>
            )}
            <span className="text-cinema-muted/40">|</span>
            {/* Score color key */}
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-cinema-teal" />
              <span>8+ Great</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-cinema-gold" />
              <span>6-8 Good</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-red-500" />
              <span>&lt;6 Poor</span>
            </div>
          </div>
          <div className="flex items-center gap-1 text-cinema-muted/60">
            {(reviewCount != null || (audienceData?.userReviewCount ?? 0) > 0) && (
              <span>
                {(reviewCount ?? 0) + (audienceData?.userReviewCount ?? 0)} reviews
              </span>
            )}
            {generatedAt && (
              <>
                <span>·</span>
                <span>Last updated {relativeTime(generatedAt)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Summary Section */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Peak moment card */}
        {peakMoment && (
          <div
            className="bg-cinema-darker rounded-lg border border-cinema-teal/20 p-4 transition-all duration-300"
            style={{
              filter: spoilersRevealed ? 'none' : 'blur(6px)',
              opacity: spoilersRevealed ? 1 : 0.6,
            }}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cinema-teal" />
              <span className="text-xs text-cinema-muted uppercase tracking-wider">Peak Moment</span>
            </div>
            <p
              className="font-[family-name:var(--font-playfair)] text-cinema-cream mb-1"
              title={peakMoment.labelFull ?? peakMoment.label}
            >
              {peakMoment.labelFull ?? peakMoment.label}
            </p>
            <div className="flex items-baseline gap-2">
              <span className="font-[family-name:var(--font-bebas)] text-2xl text-cinema-teal">
                {peakMoment.score.toFixed(1)}
              </span>
              <span className="text-xs text-cinema-muted">at {formatTime(peakMoment.time)}</span>
            </div>
          </div>
        )}

        {/* Lowest moment card */}
        {lowestMoment && (
          <div
            className="bg-cinema-darker rounded-lg border border-red-500/20 p-4 transition-all duration-300"
            style={{
              filter: spoilersRevealed ? 'none' : 'blur(6px)',
              opacity: spoilersRevealed ? 1 : 0.6,
            }}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <span className="text-xs text-cinema-muted uppercase tracking-wider">Lowest Moment</span>
            </div>
            <p
              className="font-[family-name:var(--font-playfair)] text-cinema-cream mb-1"
              title={lowestMoment.labelFull ?? lowestMoment.label}
            >
              {lowestMoment.labelFull ?? lowestMoment.label}
            </p>
            <div className="flex items-baseline gap-2">
              <span className="font-[family-name:var(--font-bebas)] text-2xl text-red-500">
                {lowestMoment.score.toFixed(1)}
              </span>
              <span className="text-xs text-cinema-muted">at {formatTime(lowestMoment.time)}</span>
            </div>
          </div>
        )}

        {/* Biggest swing card */}
        {biggestSwing && (
          <div
            className="bg-cinema-darker rounded-lg border border-cinema-gold/20 p-4 transition-all duration-300"
            style={{
              filter: spoilersRevealed ? 'none' : 'blur(6px)',
              opacity: spoilersRevealed ? 1 : 0.6,
            }}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-cinema-muted uppercase tracking-wider">Biggest Swing</span>
            </div>
            <p className="text-sm text-cinema-cream/80 leading-relaxed">{biggestSwing}</p>
          </div>
        )}
      </div>

      {/* AI Summary + Meta */}
      {(summary || reviewCount || sourcesUsed) && (
        <div className="bg-cinema-darker rounded-lg border border-cinema-border p-4">
          {summary && (
            <p className="text-sm text-cinema-cream/80 leading-relaxed italic mb-3">{summary}</p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-cinema-muted">
            {reviewCount != null && (
              <span>{reviewCount} reviews analyzed</span>
            )}
            {sourcesUsed && sourcesUsed.length > 0 && (
              <>
                <span className="text-cinema-muted/40">|</span>
                <span>Sources: {sourcesUsed.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(', ')}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
