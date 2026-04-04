import { describe, it, expect } from 'vitest'
import { calculateCompositeArc, downsampleDataPoints } from '@/lib/person-utils'
import type { SentimentDataPoint } from '@/lib/types'

function makeDp(timeMidpoint: number, score: number): SentimentDataPoint {
  return {
    timeStart: timeMidpoint - 5,
    timeEnd: timeMidpoint + 5,
    timeMidpoint,
    score,
    label: `Beat at ${timeMidpoint}m`,
    confidence: 'medium',
    reviewEvidence: '',
  }
}

// ── calculateCompositeArc ──────────────────────────────────

describe('calculateCompositeArc', () => {
  it('returns null for fewer than 3 valid films', () => {
    const films = [
      { runtime: 120, dataPoints: [makeDp(30, 7), makeDp(60, 8)], overallScore: 7.5 },
      { runtime: 90, dataPoints: [makeDp(20, 6), makeDp(50, 7)], overallScore: 6.5 },
    ]
    expect(calculateCompositeArc(films)).toBeNull()
  })

  it('produces 21 arc points (0%, 5%, ... 100%) for 3+ films', () => {
    const films = [
      { runtime: 120, dataPoints: [makeDp(15, 6), makeDp(30, 7), makeDp(60, 8), makeDp(90, 7), makeDp(105, 9)], overallScore: 7.4 },
      { runtime: 90, dataPoints: [makeDp(10, 5), makeDp(25, 6), makeDp(45, 7), makeDp(70, 8), makeDp(80, 8)], overallScore: 6.8 },
      { runtime: 150, dataPoints: [makeDp(20, 7), makeDp(50, 8), makeDp(75, 9), makeDp(120, 8), makeDp(140, 9)], overallScore: 8.2 },
    ]
    const result = calculateCompositeArc(films)
    expect(result).not.toBeNull()
    // 20 intervals = 21 points (0 through 20 inclusive)
    expect(result!.arcPoints).toHaveLength(21)
    expect(result!.arcPoints[0].percent).toBe(0)
    expect(result!.arcPoints[20].percent).toBe(100)
  })

  it('all composite scores fall between min and max input scores', () => {
    const films = [
      { runtime: 120, dataPoints: [makeDp(15, 6), makeDp(30, 7), makeDp(60, 8), makeDp(90, 7), makeDp(105, 9)], overallScore: 7.4 },
      { runtime: 90, dataPoints: [makeDp(10, 5), makeDp(25, 6), makeDp(45, 7), makeDp(70, 8), makeDp(80, 8)], overallScore: 6.8 },
      { runtime: 150, dataPoints: [makeDp(20, 7), makeDp(50, 8), makeDp(75, 9), makeDp(120, 8), makeDp(140, 9)], overallScore: 8.2 },
    ]
    const result = calculateCompositeArc(films)!
    for (const point of result.arcPoints) {
      expect(point.score).toBeGreaterThanOrEqual(5) // min input score
      expect(point.score).toBeLessThanOrEqual(9) // max input score
    }
  })

  it('averages films with different score ranges', () => {
    const highFilm = {
      runtime: 100,
      dataPoints: [makeDp(10, 8), makeDp(50, 9), makeDp(90, 8.5)],
      overallScore: 8.5,
    }
    const lowFilm = {
      runtime: 100,
      dataPoints: [makeDp(10, 4), makeDp(50, 5), makeDp(90, 4.5)],
      overallScore: 4.5,
    }
    const midFilm = {
      runtime: 100,
      dataPoints: [makeDp(10, 6), makeDp(50, 7), makeDp(90, 6.5)],
      overallScore: 6.5,
    }
    const result = calculateCompositeArc([highFilm, lowFilm, midFilm])!
    // Average of ~8.5, ~4.5, ~6.5 should be around 6-7
    for (const point of result.arcPoints) {
      expect(point.score).toBeGreaterThanOrEqual(4)
      expect(point.score).toBeLessThanOrEqual(9)
    }
    // Mid-film point should be around 7 average
    const midPoint = result.arcPoints[10] // 50%
    expect(midPoint.score).toBeGreaterThanOrEqual(6)
    expect(midPoint.score).toBeLessThanOrEqual(8)
  })

  it('computes correct average overall score', () => {
    const films = [
      { runtime: 100, dataPoints: [makeDp(10, 7), makeDp(50, 8), makeDp(90, 7)], overallScore: 8.2 },
      { runtime: 100, dataPoints: [makeDp(10, 6), makeDp(50, 7), makeDp(90, 6)], overallScore: 7.5 },
      { runtime: 100, dataPoints: [makeDp(10, 8), makeDp(50, 9), makeDp(90, 8)], overallScore: 9.0 },
    ]
    const result = calculateCompositeArc(films)!
    // (8.2 + 7.5 + 9.0) / 3 = 8.233... rounded to 8.2
    expect(result.avgScore).toBe(8.2)
  })

  it('skips films with empty data points', () => {
    const films = [
      { runtime: 100, dataPoints: [makeDp(10, 7), makeDp(50, 8), makeDp(90, 7)], overallScore: 7.3 },
      { runtime: 100, dataPoints: [], overallScore: 6.0 }, // should be skipped
      { runtime: 100, dataPoints: [makeDp(10, 6), makeDp(50, 7), makeDp(90, 6)], overallScore: 6.3 },
      { runtime: 100, dataPoints: [makeDp(10, 8), makeDp(50, 9), makeDp(90, 8)], overallScore: 8.3 },
    ]
    const result = calculateCompositeArc(films)!
    expect(result).not.toBeNull()
    // Only 3 valid films (the empty one is skipped)
    expect(result.arcPoints).toHaveLength(21)
    // avgScore should exclude the empty film: (7.3 + 6.3 + 8.3) / 3 = 7.3
    expect(result.avgScore).toBe(7.3)
  })

  it('skips films with zero runtime', () => {
    const films = [
      { runtime: 100, dataPoints: [makeDp(10, 7), makeDp(50, 8)], overallScore: 7.0 },
      { runtime: 0, dataPoints: [makeDp(10, 6), makeDp(50, 7)], overallScore: 6.0 },
      { runtime: 100, dataPoints: [makeDp(10, 6), makeDp(50, 7)], overallScore: 6.5 },
      { runtime: 100, dataPoints: [makeDp(10, 8), makeDp(50, 9)], overallScore: 8.5 },
    ]
    const result = calculateCompositeArc(films)
    expect(result).not.toBeNull()
  })
})

// ── downsampleDataPoints ───────────────────────────────────

describe('downsampleDataPoints', () => {
  it('downsamples 16 points to 8', () => {
    const dps: SentimentDataPoint[] = Array.from({ length: 16 }, (_, i) =>
      makeDp(i * 10, 5 + (i % 5)),
    )
    const result = downsampleDataPoints(dps, 8)
    expect(result).toHaveLength(8)
  })

  it('first and last points match input range boundaries', () => {
    const dps: SentimentDataPoint[] = Array.from({ length: 16 }, (_, i) =>
      makeDp(i * 10, 5 + (i % 5)),
    )
    const result = downsampleDataPoints(dps, 8)
    expect(result[0].percent).toBe(0)
    expect(result[result.length - 1].percent).toBe(100)
  })

  it('returns all points when input is smaller than requested size', () => {
    const dps = [makeDp(10, 6), makeDp(30, 7), makeDp(50, 8), makeDp(70, 7), makeDp(90, 9)]
    const result = downsampleDataPoints(dps, 10)
    expect(result).toHaveLength(5)
  })

  it('returns all points when exact size match', () => {
    const dps = Array.from({ length: 8 }, (_, i) => makeDp(i * 15, 5 + i * 0.5))
    const result = downsampleDataPoints(dps, 8)
    expect(result).toHaveLength(8)
  })

  it('handles single data point', () => {
    const dps = [makeDp(60, 7.5)]
    const result = downsampleDataPoints(dps, 8)
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(7.5)
  })

  it('returns empty array for empty input', () => {
    const result = downsampleDataPoints([], 8)
    expect(result).toHaveLength(0)
  })

  it('interpolated scores stay within input score range', () => {
    const dps = [makeDp(0, 4), makeDp(30, 6), makeDp(60, 8), makeDp(90, 5), makeDp(120, 7)]
    const result = downsampleDataPoints(dps, 10)
    for (const point of result) {
      expect(point.score).toBeGreaterThanOrEqual(4)
      expect(point.score).toBeLessThanOrEqual(8)
    }
  })
})
