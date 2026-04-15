import { describe, it, expect } from 'vitest'
import { computeSparklineRange } from '@/lib/sparkline'

describe('computeSparklineRange', () => {
  it('uses yMax = 10 and yMin = floor(lowest) - 1 for typical scores', () => {
    const { yMin, yMax, yMid } = computeSparklineRange([6.4, 7.2, 5.8, 8.1, 7.0])
    // lowest = 5.8 → floor = 5 → yMin = 5 - 1 = 4
    expect(yMin).toBe(4)
    expect(yMax).toBe(10)
    expect(yMid).toBe(7)
  })

  it('never drops yMin below 0 even when lowest is very small', () => {
    const { yMin, yMax } = computeSparklineRange([0.2, 1.5, 0.8])
    // lowest = 0.2 → floor = 0 → raw = -1 → clamped to 0
    expect(yMin).toBe(0)
    expect(yMax).toBe(10)
  })

  it('never drops yMin below 0 when the lowest is exactly 0', () => {
    const { yMin } = computeSparklineRange([0, 4, 5])
    expect(yMin).toBe(0)
  })

  it('yMin is always floor(lowest) - 1 when that result is positive', () => {
    const { yMin } = computeSparklineRange([7.9, 9.1, 8.4])
    // lowest = 7.9 → floor = 7 → yMin = 6
    expect(yMin).toBe(6)
  })

  it('returns safe defaults for an empty score array', () => {
    const { yMin, yMax, yMid } = computeSparklineRange([])
    expect(yMin).toBe(0)
    expect(yMax).toBe(10)
    expect(yMid).toBe(5)
  })

  it('handles a single data point', () => {
    const { yMin, yMax } = computeSparklineRange([4.5])
    // lowest = 4.5 → floor = 4 → yMin = 3
    expect(yMin).toBe(3)
    expect(yMax).toBe(10)
  })

  it('handles integer-valued lowest correctly', () => {
    const { yMin } = computeSparklineRange([7, 8, 9])
    // lowest = 7 → floor(7) - 1 = 6
    expect(yMin).toBe(6)
  })

  it('computes yMid as the midpoint of yMin and yMax', () => {
    const { yMin, yMax, yMid } = computeSparklineRange([3.2, 5.0, 4.1])
    expect(yMid).toBe((yMin + yMax) / 2)
  })
})
