'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'

interface ArcPoint {
  percent: number
  score: number
}

export function CompositeArcGraph({
  arcPoints,
  avgScore,
  filmCount,
}: {
  arcPoints: ArcPoint[]
  avgScore: number
  filmCount: number
}) {
  if (arcPoints.length === 0) return null

  const scores = arcPoints.map((p) => p.score)
  const minScore = Math.min(...scores)
  const maxScore = Math.max(...scores)
  const yMin = Math.max(1, Math.floor(minScore) - 1)
  const yMax = Math.min(10, Math.ceil(maxScore) + 1)

  return (
    <div className="mt-8 rounded-lg border border-cinema-border bg-[#1A1A2E] p-4 md:p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-[family-name:var(--font-playfair)] text-lg font-bold">
            Average sentiment arc
          </h2>
          <p className="text-xs text-cinema-muted mt-0.5">
            Averaged across {filmCount} films
          </p>
        </div>
        <div className="text-right">
          <span className="text-xs text-cinema-muted block">Avg. score</span>
          <span className="font-[family-name:var(--font-bebas)] text-2xl text-cinema-gold">
            {avgScore.toFixed(1)}
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={arcPoints} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id="arcGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#C8A951" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#C8A951" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="percent"
            tickFormatter={(v: number) => `${Math.round(v)}%`}
            tick={{ fill: '#666', fontSize: 11 }}
            axisLine={{ stroke: '#333' }}
            tickLine={false}
            ticks={[0, 25, 50, 75, 100]}
          />
          <YAxis
            domain={[yMin, yMax]}
            tick={{ fill: '#666', fontSize: 11 }}
            axisLine={{ stroke: '#333' }}
            tickLine={false}
            width={30}
          />
          <ReferenceLine
            y={5}
            stroke="#555"
            strokeDasharray="4 3"
            strokeWidth={0.8}
          />
          <Tooltip
            contentStyle={{
              background: '#1a1a2e',
              border: '1px solid rgba(200,169,81,0.3)',
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value) => [Number(value).toFixed(1), 'Score']}
            labelFormatter={(label) => `${Math.round(Number(label))}% through film`}
          />
          <Area
            type="monotone"
            dataKey="score"
            stroke="#C8A951"
            strokeWidth={2}
            fill="url(#arcGradient)"
            dot={false}
            activeDot={{ r: 4, fill: '#C8A951', stroke: '#0D0D1A', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
