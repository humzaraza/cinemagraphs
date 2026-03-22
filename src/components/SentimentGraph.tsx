'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
} from 'recharts'

interface DataPoint {
  position: number
  sentiment: number
  label?: string
}

interface SentimentGraphProps {
  dataPoints: DataPoint[]
  overallScore: number
  peakMoment?: { position: number; sentiment: number; label?: string } | null
  lowestMoment?: { position: number; sentiment: number; label?: string } | null
  runtime?: number | null
}

function formatPosition(position: number, runtime?: number | null): string {
  if (!runtime) return `${Math.round(position * 100)}%`
  const minutes = Math.round(position * runtime)
  return `${minutes}m`
}

export default function SentimentGraph({
  dataPoints,
  overallScore,
  peakMoment,
  lowestMoment,
  runtime,
}: SentimentGraphProps) {
  if (!dataPoints || dataPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 bg-cinema-darker rounded-lg border border-cinema-border">
        <p className="text-cinema-muted">Sentiment data not yet available</p>
      </div>
    )
  }

  return (
    <div className="bg-cinema-darker rounded-lg border border-cinema-border p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-[family-name:var(--font-playfair)] text-lg text-cinema-cream">
          Audience Sentiment
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-sm text-cinema-muted">Overall</span>
          <span className="font-[family-name:var(--font-bebas)] text-2xl text-cinema-teal">
            {overallScore.toFixed(1)}
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={dataPoints} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="sentimentGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#2DD4A8" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#2DD4A8" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3e" />
          <XAxis
            dataKey="position"
            tickFormatter={(v) => formatPosition(v, runtime)}
            stroke="#666"
            fontSize={12}
          />
          <YAxis domain={[0, 10]} stroke="#666" fontSize={12} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1a1a2e',
              border: '1px solid #2a2a3e',
              borderRadius: '8px',
              color: '#F0E6D3',
            }}
            labelFormatter={(v) => formatPosition(v as number, runtime)}
            formatter={(value) => [(value as number).toFixed(1), 'Sentiment']}
          />
          <Area
            type="monotone"
            dataKey="sentiment"
            stroke="#2DD4A8"
            strokeWidth={2}
            fill="url(#sentimentGradient)"
          />
          {peakMoment && (
            <ReferenceDot
              x={peakMoment.position}
              y={peakMoment.sentiment}
              r={6}
              fill="#C8A951"
              stroke="#C8A951"
            />
          )}
          {lowestMoment && (
            <ReferenceDot
              x={lowestMoment.position}
              y={lowestMoment.sentiment}
              r={6}
              fill="#ef4444"
              stroke="#ef4444"
            />
          )}
        </AreaChart>
      </ResponsiveContainer>

      <div className="flex gap-4 mt-3 text-xs text-cinema-muted">
        {peakMoment?.label && (
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-cinema-gold" />
            <span>Peak: {peakMoment.label}</span>
          </div>
        )}
        {lowestMoment?.label && (
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            <span>Low: {lowestMoment.label}</span>
          </div>
        )}
      </div>
    </div>
  )
}
