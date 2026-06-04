import { describe, it, expect } from 'vitest'
import { computeSwingMagnitude } from '@/lib/sentiment-metrics'

describe('computeSwingMagnitude', () => {
  it('returns the absolute gap between peak and low scores', () => {
    expect(computeSwingMagnitude({ score: 9.2 }, { score: 4.1 })).toBeCloseTo(5.1)
  })

  it('is order-independent (absolute value)', () => {
    expect(computeSwingMagnitude({ score: 3 }, { score: 8 })).toBe(5)
  })

  it('returns 0 when a moment is null or missing', () => {
    expect(computeSwingMagnitude(null, { score: 8 })).toBe(0)
    expect(computeSwingMagnitude({ score: 8 }, null)).toBe(0)
    expect(computeSwingMagnitude(undefined, undefined)).toBe(0)
  })

  it('returns 0 when score is absent or non-numeric', () => {
    expect(computeSwingMagnitude({ label: 'x' }, { score: 8 })).toBe(0)
    expect(computeSwingMagnitude({ score: 'high' }, { score: 8 })).toBe(0)
    expect(computeSwingMagnitude({ score: Number.NaN }, { score: 8 })).toBe(0)
  })

  it('ignores extra PeakLowMoment fields and reads only score', () => {
    const peak = { label: 'Climax', labelFull: 'The climax', score: 9, time: 110 }
    const low = { label: 'Dip', score: 5, time: 40 }
    expect(computeSwingMagnitude(peak, low)).toBe(4)
  })
})
