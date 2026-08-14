import { describe, it, expect } from 'vitest'

import {
  hasRuntime,
  rulerInterval,
  formatRulerLabel,
  buildRulerMinutes,
  buildTimeAxis,
  originFadeOffset,
} from '@/lib/time-axis'

describe('hasRuntime', () => {
  it('accepts a positive finite runtime and nothing else', () => {
    expect(hasRuntime(95)).toBe(true)
    expect(hasRuntime(null)).toBe(false)
    expect(hasRuntime(undefined)).toBe(false)
    expect(hasRuntime(0)).toBe(false)
    expect(hasRuntime(-10)).toBe(false)
    expect(hasRuntime(NaN)).toBe(false)
    expect(hasRuntime(Infinity)).toBe(false)
  })
})

describe('rulerInterval', () => {
  it('uses 15-minute ticks under 90 minutes and 30-minute from there up', () => {
    expect(rulerInterval(88)).toBe(15)
    expect(rulerInterval(90)).toBe(30)
    expect(rulerInterval(116)).toBe(30)
    expect(rulerInterval(195)).toBe(30)
  })

  it('steps down the ladder when a short film would get fewer than 3 ticks', () => {
    expect(rulerInterval(30)).toBe(10)
    expect(rulerInterval(12)).toBe(5)
  })

  it('steps up the ladder when a long film would get more than 7 ticks', () => {
    expect(rulerInterval(240)).toBe(60)
    expect(rulerInterval(480)).toBe(120)
  })

  it('clamps at the bottom of the ladder, letting a very short film degenerate below 3 ticks', () => {
    expect(rulerInterval(8)).toBe(5)
    expect(buildRulerMinutes(8)).toEqual([0, 5])
  })

  it('clamps at the top of the ladder, letting an absurdly long runtime exceed 7 ticks', () => {
    expect(rulerInterval(2000)).toBe(240)
    expect(buildRulerMinutes(2000)).toHaveLength(9)
  })
})

describe('formatRulerLabel', () => {
  it('formats zero, sub-hour, on-the-hour, and past-hour minutes', () => {
    expect(formatRulerLabel(0)).toBe('0m')
    expect(formatRulerLabel(45)).toBe('45m')
    expect(formatRulerLabel(60)).toBe('1h')
    expect(formatRulerLabel(90)).toBe('1h 30m')
  })
})

describe('buildRulerMinutes', () => {
  it('a 116 minute film gets 30-minute ticks with none at the runtime', () => {
    expect(buildRulerMinutes(116)).toEqual([0, 30, 60, 90])
  })

  it('a runtime on an exact interval multiple still gets no tick at the runtime', () => {
    expect(buildRulerMinutes(120)).toEqual([0, 30, 60, 90])
  })

  it('an 88 minute film uses the 15-minute interval', () => {
    expect(buildRulerMinutes(88)).toEqual([0, 15, 30, 45, 60, 75])
  })

  it('never places a tick at or past the runtime, across a sweep of runtimes', () => {
    for (let runtime = 1; runtime <= 400; runtime++) {
      const minutes = buildRulerMinutes(runtime)
      expect(minutes[0]).toBe(0)
      expect(minutes[minutes.length - 1]).toBeLessThan(runtime)
      // The ladder's tick-count window: never more than 7, and at least 3
      // once the runtime clears the degenerate-short clamp (10 minutes or
      // less at the 5-minute floor).
      expect(minutes.length).toBeLessThanOrEqual(7)
      if (runtime >= 11) expect(minutes.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('yields no minutes for a missing or unusable runtime', () => {
    expect(buildRulerMinutes(null)).toEqual([])
    expect(buildRulerMinutes(undefined)).toEqual([])
    expect(buildRulerMinutes(0)).toEqual([])
  })
})

describe('buildTimeAxis', () => {
  it('builds a [0, runtime] domain with the ruler ticks', () => {
    expect(buildTimeAxis(116)).toEqual({ domain: [0, 116], ticks: [0, 30, 60, 90] })
  })

  it('is null without a usable runtime, which is the categorical-fallback signal', () => {
    expect(buildTimeAxis(null)).toBeNull()
    expect(buildTimeAxis(undefined)).toBeNull()
    expect(buildTimeAxis(0)).toBeNull()
    expect(buildTimeAxis(NaN)).toBeNull()
  })
})

describe('originFadeOffset', () => {
  // Origin row plus the midpoints of eight equal buckets of a 120 minute
  // runtime, which is how the pipeline actually places beats.
  const equalBuckets = [
    { timeMidpoint: 0 },
    ...Array.from({ length: 8 }, (_, i) => ({ timeMidpoint: 7.5 + i * 15 })),
  ]

  it('categorical: evenly spaced rows put the first beat at 1/(rows-1)', () => {
    expect(originFadeOffset(equalBuckets, false)).toBeCloseTo(1 / 8, 10)
  })

  it("numeric: the first beat sits at firstMid/lastMid of the series' bounding box", () => {
    // The mask is sized to the drawn series (0m through the last midpoint,
    // 112.5), not to the [0, runtime] domain, so the offset is 7.5/112.5,
    // not 7.5/120.
    expect(originFadeOffset(equalBuckets, true)).toBeCloseTo(7.5 / 112.5, 10)
  })

  it('numeric: beats at uneven positions still divide first by last midpoint', () => {
    const rows = [{ timeMidpoint: 0 }, { timeMidpoint: 5 }, { timeMidpoint: 40 }, { timeMidpoint: 110 }]
    expect(originFadeOffset(rows, true)).toBeCloseTo(5 / 110, 10)
  })

  it('degenerates to 0 rather than dividing by zero', () => {
    expect(originFadeOffset([], true)).toBe(0)
    expect(originFadeOffset([{ timeMidpoint: 0 }], true)).toBe(0)
    expect(originFadeOffset([{ timeMidpoint: 0 }, { timeMidpoint: 0 }], true)).toBe(0)
  })

  it('categorical path shares the too-few-rows guard', () => {
    expect(originFadeOffset([], false)).toBe(0)
    expect(originFadeOffset([{ timeMidpoint: 0 }], false)).toBe(0)
  })
})
