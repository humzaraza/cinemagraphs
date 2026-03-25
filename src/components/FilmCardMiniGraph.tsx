'use client'

import { AreaChart, Area, YAxis, XAxis, ResponsiveContainer } from 'recharts'
import type { MiniGraphDataPoint } from '@/lib/types'

export function FilmCardMiniGraph({ dataPoints }: { dataPoints: MiniGraphDataPoint[] }) {
  if (!dataPoints || dataPoints.length === 0) return null

  // Compute timeMidpoint if missing
  const chartData = dataPoints.map((dp) => ({
    ...dp,
    timeMidpoint: dp.timeMidpoint ?? Math.round(((dp.timeStart ?? 0) + (dp.timeEnd ?? 0)) / 2),
  }))

  return (
    <div className="w-full h-10">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 1, right: 1, left: 1, bottom: 1 }}>
          <defs>
            <linearGradient id="miniCardGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#C8A951" stopOpacity={0.5} />
              <stop offset="95%" stopColor="#C8A951" stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={[1, 10]} hide />
          <XAxis dataKey="timeMidpoint" hide />
          <Area
            type="monotone"
            dataKey="score"
            stroke="#C8A951"
            strokeWidth={1.5}
            fill="url(#miniCardGradient)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
