'use client'

import { computeSparklineRange } from '@/lib/sparkline'

interface Props {
  scores: number[]
  runtime: number | null
  width?: number
  height?: number
}

function formatRuntime(minutes: number | null): string {
  if (!minutes || minutes <= 0) return ''
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export function ListSparkline({ scores, runtime, width = 200, height = 62 }: Props) {
  const { yMin, yMax } = computeSparklineRange(scores)
  const yRange = yMax - yMin || 1
  const yMid = Math.round(((yMin + yMax) / 2) * 10) / 10

  const labelColW = 18
  const labelRowH = 10
  const graphX = labelColW
  const graphY = 4
  const graphW = width - labelColW - 4
  const graphH = height - graphY - labelRowH - 2

  const includeReferenceLine = 5 >= yMin && 5 <= yMax
  const refY = graphY + graphH - ((5 - yMin) / yRange) * graphH

  const hasEnough = scores.length >= 2
  const points = hasEnough
    ? scores.map((score, i) => {
        const x = graphX + (i / (scores.length - 1)) * graphW
        const y = graphY + graphH - ((score - yMin) / yRange) * graphH
        return { x, y }
      })
    : []

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ')

  const runtimeLabel = formatRuntime(runtime)

  return (
    <div
      className="w-full"
      style={{
        background: 'rgba(13,13,26,0.6)',
        padding: '6px 6px 4px',
      }}
    >
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {/* Y-axis labels */}
        <text x={2} y={graphY + 5} fill="rgba(245,240,225,0.35)" fontSize="7" fontFamily="var(--font-dm-sans), sans-serif">
          {yMax}
        </text>
        <text x={2} y={graphY + graphH / 2 + 2} fill="rgba(245,240,225,0.35)" fontSize="7" fontFamily="var(--font-dm-sans), sans-serif">
          {yMid}
        </text>
        <text x={2} y={graphY + graphH + 2} fill="rgba(245,240,225,0.35)" fontSize="7" fontFamily="var(--font-dm-sans), sans-serif">
          {yMin}
        </text>

        {/* Dashed reference line at 5.0 (only when within range) */}
        {includeReferenceLine && (
          <line
            x1={graphX}
            y1={refY}
            x2={graphX + graphW}
            y2={refY}
            stroke="rgba(245,240,225,0.08)"
            strokeWidth={0.8}
            strokeDasharray="3 3"
          />
        )}

        {/* Data line */}
        {hasEnough && (
          <path
            d={pathD}
            fill="none"
            stroke="#C8A951"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Timestamps */}
        <text
          x={graphX}
          y={height - 2}
          fill="rgba(245,240,225,0.2)"
          fontSize="7"
          fontFamily="var(--font-dm-sans), sans-serif"
        >
          0m
        </text>
        {runtimeLabel && (
          <text
            x={graphX + graphW}
            y={height - 2}
            fill="rgba(245,240,225,0.2)"
            fontSize="7"
            fontFamily="var(--font-dm-sans), sans-serif"
            textAnchor="end"
          >
            {runtimeLabel}
          </text>
        )}
      </svg>
    </div>
  )
}
