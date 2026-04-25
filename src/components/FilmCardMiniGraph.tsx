'use client'

import { useState, useRef, useCallback } from 'react'
import type { MiniGraphDataPoint } from '@/lib/types'

const GRAPH_HEIGHT = 48
const GRAPH_PADDING_X = 4
const GRAPH_PADDING_TOP = 4
const GRAPH_PADDING_BOTTOM = 2
const SVG_WIDTH = 300

function scoreToY(score: number): number {
  const drawableHeight = GRAPH_HEIGHT - GRAPH_PADDING_TOP - GRAPH_PADDING_BOTTOM
  return GRAPH_PADDING_TOP + ((10 - score) / 9) * drawableHeight
}

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m}m`
  return `${h}h${m.toString().padStart(2, '0')}m`
}

function scoreColor(score: number): string {
  if (score >= 8) return 'var(--cinema-teal)'
  if (score >= 6) return 'var(--cinema-gold)'
  return '#ef4444'
}

interface HoverInfo {
  svgX: number
  score: number
  label?: string
}

export function FilmCardMiniGraph({
  dataPoints,
  runtime,
}: {
  dataPoints: MiniGraphDataPoint[]
  runtime: number | null
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)

  if (!dataPoints || dataPoints.length === 0) {
    return (
      <div>
        <svg
          viewBox={`0 0 ${SVG_WIDTH} ${GRAPH_HEIGHT}`}
          preserveAspectRatio="none"
          className="w-full"
          style={{ height: GRAPH_HEIGHT, display: 'block' }}
        >
          <line
            x1={GRAPH_PADDING_X}
            y1={GRAPH_HEIGHT / 2}
            x2={SVG_WIDTH - GRAPH_PADDING_X}
            y2={GRAPH_HEIGHT / 2}
            stroke="#555"
            strokeWidth={0.8}
            strokeDasharray="4 3"
          />
        </svg>
      </div>
    )
  }

  const chartData = dataPoints.map((dp) => ({
    ...dp,
    timeMidpoint: dp.timeMidpoint ?? Math.round(((dp.timeStart ?? 0) + (dp.timeEnd ?? 0)) / 2),
  }))

  const allPoints: { timeMidpoint: number; score: number; label?: string }[] = [
    { timeMidpoint: 0, score: 5 },
    ...chartData.map((dp) => ({
      timeMidpoint: dp.timeMidpoint,
      score: dp.score,
      label: ((dp as any).labelFull ?? (dp as any).label) as string | undefined,
    })),
  ]

  const times = allPoints.map((d) => d.timeMidpoint)
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const timeRange = maxTime - minTime || 1

  function timeToX(t: number): number {
    return GRAPH_PADDING_X + ((t - minTime) / timeRange) * (SVG_WIDTH - GRAPH_PADDING_X * 2)
  }

  const linePoints = allPoints.map((d) => ({
    x: timeToX(d.timeMidpoint),
    y: scoreToY(d.score),
    score: d.score,
    label: d.label,
  }))

  const linePath = linePoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const fillPath =
    linePath +
    ` L${linePoints[linePoints.length - 1].x},${GRAPH_HEIGHT} L${linePoints[0].x},${GRAPH_HEIGHT} Z`

  const neutralY = scoreToY(5)
  const lastDp = chartData[chartData.length - 1]
  const endTime = runtime ?? lastDp?.timeMidpoint ?? maxTime

  const gradientId = `miniGrad-${dataPoints.length}-${allPoints[1]?.timeMidpoint ?? 0}`

  const interpolateAtX = useCallback(
    (svgX: number): HoverInfo | null => {
      if (svgX < linePoints[0].x || svgX > linePoints[linePoints.length - 1].x) return null

      for (let i = 0; i < linePoints.length - 1; i++) {
        const a = linePoints[i]
        const b = linePoints[i + 1]
        if (svgX >= a.x && svgX <= b.x) {
          const t = (svgX - a.x) / (b.x - a.x || 1)
          const score = a.score + t * (b.score - a.score)
          const nearest = t < 0.5 ? a : b
          return { svgX, score: Math.round(score * 10) / 10, label: nearest.label }
        }
      }
      return null
    },
    [linePoints],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const relX = e.clientX - rect.left
      const svgX = (relX / rect.width) * SVG_WIDTH
      const info = interpolateAtX(svgX)
      setHover(info)
    },
    [interpolateAtX],
  )

  const handleMouseLeave = useCallback(() => setHover(null), [])

  // Position tooltip inside the SVG area to avoid overflow-hidden clipping
  const hoverY = hover ? scoreToY(hover.score) : 0
  const tooltipText = hover ? `${hover.score.toFixed(1)}${hover.label ? ` ${hover.label}` : ''}` : ''
  // Keep tooltip inside SVG bounds
  const tooltipX = hover ? Math.max(30, Math.min(hover.svgX, SVG_WIDTH - 30)) : 0
  // Place tooltip above the dot, or below if too close to top
  const tooltipY = hover ? (hoverY > 18 ? hoverY - 10 : hoverY + 14) : 0

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_WIDTH} ${GRAPH_HEIGHT}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: GRAPH_HEIGHT, display: 'block' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cinema-gold)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--cinema-gold)" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Fill area */}
        <path d={fillPath} fill={`url(#${gradientId})`} />

        {/* Dashed neutral line at score=5 */}
        <line
          x1={GRAPH_PADDING_X}
          y1={neutralY}
          x2={SVG_WIDTH - GRAPH_PADDING_X}
          y2={neutralY}
          stroke="#555"
          strokeWidth={0.8}
          strokeDasharray="4 3"
        />

        {/* Gold line */}
        <path d={linePath} fill="none" stroke="var(--cinema-gold)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />

        {/* Hover elements — all inside SVG so they're never clipped */}
        {hover && (
          <>
            {/* Vertical cursor line */}
            <line
              x1={hover.svgX}
              y1={GRAPH_PADDING_TOP}
              x2={hover.svgX}
              y2={GRAPH_HEIGHT - GRAPH_PADDING_BOTTOM}
              stroke="rgba(200,169,110,0.4)"
              strokeWidth={0.8}
            />
            {/* Dot on the line */}
            <circle
              cx={hover.svgX}
              cy={hoverY}
              r={3}
              fill={scoreColor(hover.score)}
              stroke="var(--cinema-dark)"
              strokeWidth={1}
            />
            {/* Tooltip background */}
            <rect
              x={tooltipX - tooltipText.length * 2.8 - 4}
              y={tooltipY - 6}
              width={tooltipText.length * 5.6 + 8}
              height={12}
              rx={2}
              fill="var(--cinema-card)"
              stroke="rgba(200,169,110,0.3)"
              strokeWidth={0.5}
            />
            {/* Tooltip text */}
            <text
              x={tooltipX}
              y={tooltipY + 2.5}
              textAnchor="middle"
              fontSize={7}
              fontWeight={600}
              fill={scoreColor(hover.score)}
              style={{ pointerEvents: 'none' }}
            >
              {tooltipText}
            </text>
          </>
        )}
      </svg>

      {/* Runtime labels */}
      <div className="flex justify-between px-0.5 mt-0.5">
        <span className="text-[9px] text-cinema-muted/50">0m</span>
        <span className="text-[9px] text-cinema-muted/50">
          {endTime > 0 ? formatRuntime(endTime) : ''}
        </span>
      </div>
    </div>
  )
}
