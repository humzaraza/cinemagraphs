import type { SentimentDataPoint } from './types'

/**
 * Downsample sentiment data points to a fixed number of evenly-spaced points.
 * Uses linear interpolation between nearest data points.
 */
export function downsampleDataPoints(
  dataPoints: SentimentDataPoint[],
  targetCount: number = 10,
): { percent: number; score: number }[] {
  if (dataPoints.length === 0) return []
  if (dataPoints.length <= targetCount) {
    return dataPoints.map((dp) => ({ percent: dp.timeMidpoint, score: dp.score }))
  }

  const sorted = [...dataPoints].sort((a, b) => a.timeMidpoint - b.timeMidpoint)
  const minTime = sorted[0].timeMidpoint
  const maxTime = sorted[sorted.length - 1].timeMidpoint
  const timeRange = maxTime - minTime
  if (timeRange === 0) return [{ percent: 0, score: sorted[0].score }]

  const result: { percent: number; score: number }[] = []
  for (let i = 0; i < targetCount; i++) {
    const t = minTime + (i / (targetCount - 1)) * timeRange
    const score = interpolateAt(sorted, t)
    result.push({ percent: (i / (targetCount - 1)) * 100, score })
  }
  return result
}

/**
 * Calculate a composite arc for a director across multiple films.
 * Normalizes each film to a 0-100% timeline and averages at 20 fixed intervals.
 */
export function calculateCompositeArc(
  films: {
    runtime: number
    dataPoints: SentimentDataPoint[]
    overallScore: number
  }[],
): { arcPoints: { percent: number; score: number }[]; avgScore: number } | null {
  const validFilms = films.filter((f) => f.dataPoints.length > 0 && f.runtime > 0)
  if (validFilms.length < 3) return null

  const INTERVALS = 20
  const arcPoints: { percent: number; score: number }[] = []

  for (let i = 0; i <= INTERVALS; i++) {
    const percent = (i / INTERVALS) * 100
    let totalScore = 0

    for (const film of validFilms) {
      // Convert percent back to film time
      const filmTime = (percent / 100) * film.runtime
      const sorted = [...film.dataPoints].sort((a, b) => a.timeMidpoint - b.timeMidpoint)
      totalScore += interpolateAt(sorted, filmTime)
    }

    arcPoints.push({
      percent,
      score: Math.round((totalScore / validFilms.length) * 100) / 100,
    })
  }

  const avgScore =
    Math.round(
      (validFilms.reduce((sum, f) => sum + f.overallScore, 0) / validFilms.length) * 10,
    ) / 10

  return { arcPoints, avgScore }
}

/** Linear interpolation at a given time within sorted data points */
function interpolateAt(sorted: SentimentDataPoint[], time: number): number {
  if (sorted.length === 0) return 5
  if (time <= sorted[0].timeMidpoint) return sorted[0].score
  if (time >= sorted[sorted.length - 1].timeMidpoint) return sorted[sorted.length - 1].score

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (time >= a.timeMidpoint && time <= b.timeMidpoint) {
      const t = (time - a.timeMidpoint) / (b.timeMidpoint - a.timeMidpoint)
      return a.score + t * (b.score - a.score)
    }
  }
  return sorted[sorted.length - 1].score
}
