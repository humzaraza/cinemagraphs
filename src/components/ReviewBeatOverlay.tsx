import { buildBeatOverlay } from '@/lib/beat-overlay'

// Shared by the review detail page (server component) and the profile page
// (client component), so no 'use client' directive and no hooks: the file
// must sit in whichever module graph imports it.

interface ReviewBeatOverlayProps {
  dataPoints: { label: string; score: number }[]
  beatRatings: Record<string, number> | null
  width: number
  height: number
  padding: number
  strokeWidth: number
  dashArray: string
  dotRadius: number
}

export default function ReviewBeatOverlay({
  dataPoints,
  beatRatings,
  width,
  height,
  padding,
  strokeWidth,
  dashArray,
  dotRadius,
}: ReviewBeatOverlayProps) {
  const { goldPath, ratedRuns, dots } = buildBeatOverlay(dataPoints, beatRatings, {
    width,
    height,
    padding,
  })

  return (
    <svg width={width} height={height} className="w-full" viewBox={`0 0 ${width} ${height}`}>
      {goldPath && (
        <path
          d={goldPath}
          fill="none"
          stroke="var(--cinema-gold)"
          strokeWidth={strokeWidth}
          opacity="0.6"
        />
      )}
      {ratedRuns.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="var(--cinema-teal)"
          strokeWidth={strokeWidth}
          strokeDasharray={dashArray}
          opacity="0.8"
        />
      ))}
      {dots.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={dotRadius} fill="var(--cinema-teal)" />
      ))}
    </svg>
  )
}
