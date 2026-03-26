'use client'

import type { MiniGraphDataPoint } from '@/lib/types'

const GRAPH_HEIGHT = 48
const GRAPH_PADDING_X = 4
const GRAPH_PADDING_TOP = 4
const GRAPH_PADDING_BOTTOM = 2

function scoreToY(score: number): number {
  // Map score (1–10) to y position within drawable area
  const drawableHeight = GRAPH_HEIGHT - GRAPH_PADDING_TOP - GRAPH_PADDING_BOTTOM
  return GRAPH_PADDING_TOP + ((10 - score) / 9) * drawableHeight
}

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m}m`
  return `${h}h${m.toString().padStart(2, '0')}m`
}

export function FilmCardMiniGraph({
  dataPoints,
  runtime,
}: {
  dataPoints: MiniGraphDataPoint[]
  runtime: number | null
}) {
  if (!dataPoints || dataPoints.length === 0) {
    // Flat dashed placeholder line
    return (
      <div>
        <svg
          viewBox={`0 0 ${300} ${GRAPH_HEIGHT}`}
          preserveAspectRatio="none"
          className="w-full"
          style={{ height: GRAPH_HEIGHT, display: 'block' }}
        >
          <line
            x1={GRAPH_PADDING_X}
            y1={GRAPH_HEIGHT / 2}
            x2={300 - GRAPH_PADDING_X}
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

  // Prepend synthetic neutral start point
  const allPoints = [{ timeMidpoint: 0, score: 5 }, ...chartData]

  // X range
  const times = allPoints.map((d) => d.timeMidpoint)
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const timeRange = maxTime - minTime || 1

  // Compute SVG width from container — use 100% via viewBox
  const SVG_WIDTH = 300

  function timeToX(t: number): number {
    return GRAPH_PADDING_X + ((t - minTime) / timeRange) * (SVG_WIDTH - GRAPH_PADDING_X * 2)
  }

  // Build the line path
  const linePoints = allPoints.map((d) => ({
    x: timeToX(d.timeMidpoint),
    y: scoreToY(d.score),
  }))

  const linePath = linePoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')

  // Build the fill path (close to bottom)
  const fillPath =
    linePath +
    ` L${linePoints[linePoints.length - 1].x},${GRAPH_HEIGHT} L${linePoints[0].x},${GRAPH_HEIGHT} Z`

  // Neutral line at score=5
  const neutralY = scoreToY(5)

  // Runtime label — use last data point's end time or runtime prop
  const lastDp = chartData[chartData.length - 1]
  const endTime = runtime ?? lastDp?.timeMidpoint ?? maxTime

  return (
    <div>
      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${GRAPH_HEIGHT}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: GRAPH_HEIGHT, display: 'block' }}
      >
        <defs>
          <linearGradient id="miniGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#C8A951" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#C8A951" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Fill area */}
        <path d={fillPath} fill="url(#miniGradient)" />

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
        <path d={linePath} fill="none" stroke="#C8A951" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
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
