'use client'

import { useState } from 'react'
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
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m}m`
  return `${h}h ${m.toString().padStart(2, '0')}m`
}

function scoreColor(score: number): string {
  if (score >= 8) return '#2DD4A8' // teal
  if (score >= 6) return '#C8A951' // gold
  return '#ef4444' // red
}

function confidenceRadius(confidence: string): number {
  if (confidence === 'high') return 8
  if (confidence === 'medium') return 6
  return 4
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload?.length) return null
  const data = payload[0].payload as SentimentDataPoint
  return (
    <div className="bg-[#1a1a2e] border border-[#2a2a3e] rounded-lg p-3 max-w-xs shadow-xl">
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="text-cinema-cream font-semibold text-sm">{data.label}</span>
        <span
          className="font-[family-name:var(--font-bebas)] text-xl"
          style={{ color: scoreColor(data.score) }}
        >
          {data.score.toFixed(1)}
        </span>
      </div>
      <div className="text-xs text-cinema-muted mb-1">
        {formatTime(data.timeStart)} – {formatTime(data.timeEnd)}
      </div>
      <div className="flex items-center gap-1 mb-2">
        <span
          className="w-2 h-2 rounded-full"
          style={{
            backgroundColor:
              data.confidence === 'high' ? '#2DD4A8' : data.confidence === 'medium' ? '#C8A951' : '#666',
          }}
        />
        <span className="text-xs text-cinema-muted capitalize">{data.confidence} confidence</span>
      </div>
      {data.reviewEvidence && (
        <p className="text-xs text-cinema-cream/70 italic leading-relaxed">{data.reviewEvidence}</p>
      )}
    </div>
  )
}

// ── Main Graph ──

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
}: SentimentGraphProps) {
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)

  if (!dataPoints || dataPoints.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 bg-cinema-darker rounded-lg border border-cinema-border">
        <p className="text-cinema-muted mb-1">Sentiment analysis coming soon</p>
        <p className="text-xs text-cinema-muted/60">Graph will appear once reviews are analyzed</p>
      </div>
    )
  }

  // Map data for the chart — compute timeMidpoint if missing
  const chartData = dataPoints.map((dp) => ({
    ...dp,
    timeMidpoint: dp.timeMidpoint ?? Math.round((dp.timeStart + dp.timeEnd) / 2),
    fill: scoreColor(dp.score),
  }))

  // Compute IMDb anchor from anchoredFrom string
  const imdbAnchor = anchoredFrom
    ? parseFloat(anchoredFrom.match(/IMDb ([\d.]+)/)?.[1] || '0') || null
    : null

  return (
    <div className="space-y-6">
      {/* Main Graph */}
      <div className="bg-cinema-darker rounded-lg border border-cinema-border p-4 md:p-6">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-[family-name:var(--font-playfair)] text-lg text-cinema-cream">
            Audience Sentiment
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-sm text-cinema-muted">Overall</span>
            <span
              className="font-[family-name:var(--font-bebas)] text-3xl"
              style={{ color: scoreColor(overallScore) }}
            >
              {overallScore.toFixed(1)}
            </span>
          </div>
        </div>
        {anchoredFrom && (
          <p className="text-xs text-cinema-muted mb-4">Anchored from {anchoredFrom}</p>
        )}

        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={chartData} margin={{ top: 10, right: 35, left: 10, bottom: 30 }}>
            <defs>
              <linearGradient id="sentimentGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#C8A951" stopOpacity={0.3} />
                <stop offset="50%" stopColor="#C8A951" stopOpacity={0.1} />
                <stop offset="95%" stopColor="#C8A951" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3e" />
            <XAxis
              dataKey="timeMidpoint"
              tickFormatter={formatTime}
              stroke="#666"
              fontSize={11}
              label={{ value: runtime ? `Runtime: ${formatTime(runtime)}` : '', position: 'bottom', offset: 10, fill: '#666', fontSize: 11 }}
            />
            {/* Left Y-axis (default) */}
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
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#C8A951', strokeOpacity: 0.3, strokeDasharray: '4 4' }} />

            {/* Neutral reference line */}
            <ReferenceLine y={5} stroke="#666" strokeDasharray="6 4" />

            {/* IMDb anchor line */}
            {imdbAnchor && (
              <ReferenceLine
                y={imdbAnchor}
                stroke="#C8A951"
                strokeDasharray="4 4"
                strokeOpacity={0.6}
                label={{ value: `IMDb ${imdbAnchor}`, fill: '#C8A951', fontSize: 10, position: 'insideTopLeft' }}
              />
            )}

            <Area
              type="monotone"
              dataKey="score"
              stroke="#C8A951"
              strokeWidth={2.5}
              fill="url(#sentimentGradient)"
              isAnimationActive={false}
              dot={(props: any) => {
                const { cx, cy, payload, index } = props
                if (cx == null || cy == null) return <circle r={0} />
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
                        <animate attributeName="r" from={String(r + 2)} to={String(r + 6)} dur="1s" repeatCount="indefinite" />
                        <animate attributeName="opacity" from="0.6" to="0" dur="1s" repeatCount="indefinite" />
                      </circle>
                    )}
                    <circle
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill={color}
                      stroke={isHighlighted ? '#fff' : '#1a1a2e'}
                      strokeWidth={isHighlighted ? 3 : 2}
                      style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
                    />
                  </g>
                )
              }}
              activeDot={(props: any) => {
                const { cx, cy, payload, index } = props
                if (cx == null || cy == null) return <circle r={0} />
                const r = confidenceRadius(payload.confidence) + 3
                const color = scoreColor(payload.score)
                return (
                  <circle
                    key={`activedot-${index}`}
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill={color}
                    stroke="#F0E6D3"
                    strokeWidth={2}
                    style={{ cursor: 'pointer' }}
                  />
                )
              }}
            />

            {/* Peak moment */}
            {peakMoment && (
              <ReferenceDot
                x={peakMoment.time}
                y={peakMoment.score}
                r={8}
                fill="#2DD4A8"
                stroke="#F0E6D3"
                strokeWidth={2}
              />
            )}

            {/* Lowest moment */}
            {lowestMoment && (
              <ReferenceDot
                x={lowestMoment.time}
                y={lowestMoment.score}
                r={8}
                fill="#ef4444"
                stroke="#F0E6D3"
                strokeWidth={2}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>

        {/* Scale labels */}
        <div className="flex justify-between text-[10px] text-cinema-muted/60 mt-1 px-8">
          <span>1 — Hated it</span>
          <span>5 — Neutral</span>
          <span>10 — Masterpiece</span>
        </div>

        {/* Story beat pills — each maps 1:1 to a graph dot */}
        <div className="flex flex-wrap gap-1.5 mt-4">
          {chartData.map((dp, i) => {
            const color = scoreColor(dp.score)
            const isActive = highlightedIndex === i
            return (
              <button
                key={i}
                type="button"
                className="text-[10px] px-2 py-0.5 rounded-full border transition-all duration-200"
                style={{
                  color: isActive ? '#1a1a2e' : color,
                  borderColor: isActive ? color : color + '40',
                  backgroundColor: isActive ? color : color + '10',
                  transform: isActive ? 'scale(1.1)' : 'scale(1)',
                  boxShadow: isActive ? `0 0 8px ${color}60` : 'none',
                }}
                onMouseEnter={() => setHighlightedIndex(i)}
                onMouseLeave={() => setHighlightedIndex(null)}
                onClick={() => setHighlightedIndex(highlightedIndex === i ? null : i)}
              >
                {dp.label}
              </button>
            )
          })}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4 mt-4 text-xs text-cinema-muted">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-[#2DD4A8]" />
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
          <span className="text-cinema-muted/40">|</span>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-cinema-muted" />
            <span>Low</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-cinema-muted" />
            <span>Med</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-cinema-muted" />
            <span>High confidence</span>
          </div>
        </div>
      </div>

      {/* Summary Section */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Peak moment card */}
        {peakMoment && (
          <div className="bg-cinema-darker rounded-lg border border-[#2DD4A8]/20 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[#2DD4A8]" />
              <span className="text-xs text-cinema-muted uppercase tracking-wider">Peak Moment</span>
            </div>
            <p className="font-[family-name:var(--font-playfair)] text-cinema-cream mb-1">
              {peakMoment.label}
            </p>
            <div className="flex items-baseline gap-2">
              <span
                className="font-[family-name:var(--font-bebas)] text-2xl text-[#2DD4A8]"
              >
                {peakMoment.score.toFixed(1)}
              </span>
              <span className="text-xs text-cinema-muted">at {formatTime(peakMoment.time)}</span>
            </div>
          </div>
        )}

        {/* Lowest moment card */}
        {lowestMoment && (
          <div className="bg-cinema-darker rounded-lg border border-red-500/20 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <span className="text-xs text-cinema-muted uppercase tracking-wider">Lowest Moment</span>
            </div>
            <p className="font-[family-name:var(--font-playfair)] text-cinema-cream mb-1">
              {lowestMoment.label}
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
          <div className="bg-cinema-darker rounded-lg border border-cinema-gold/20 p-4">
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
                <span>Sources: {sourcesUsed.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ')}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
