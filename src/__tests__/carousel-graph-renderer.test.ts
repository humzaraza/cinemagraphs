import { describe, it, expect } from 'vitest'
import {
  computeDotColor,
  computeYRange,
  prependNeutralAnchor,
  renderGraph,
  type DataPoint,
} from '@/lib/carousel/graph-renderer'

describe('computeYRange', () => {
  it('typical mid-high spread → floor(min)-1 / ceil(max)+1 clamped to [1,10]', () => {
    expect(computeYRange([5.0, 5.8, 7.8, 8.1, 9.5])).toEqual({ yMin: 4, yMax: 10 })
  })
  it('high-end scores clamp yMax at 10', () => {
    expect(computeYRange([9.0, 9.5, 9.8])).toEqual({ yMin: 8, yMax: 10 })
  })
  it('low-end scores clamp yMin at 1', () => {
    expect(computeYRange([1.0, 1.5, 2.0])).toEqual({ yMin: 1, yMax: 3 })
  })
  it('single-point input', () => {
    expect(computeYRange([5.0])).toEqual({ yMin: 4, yMax: 6 })
  })
})

describe('computeDotColor', () => {
  it('classifies 5.99 as red', () => {
    expect(computeDotColor(5.99)).toBe('red')
  })
  it('classifies 6.0 as gold (boundary)', () => {
    expect(computeDotColor(6.0)).toBe('gold')
  })
  it('classifies 7.99 as gold', () => {
    expect(computeDotColor(7.99)).toBe('gold')
  })
  it('classifies 8.0 as teal (boundary)', () => {
    expect(computeDotColor(8.0)).toBe('teal')
  })
  it('classifies 10.0 as teal', () => {
    expect(computeDotColor(10.0)).toBe('teal')
  })
})

describe('prependNeutralAnchor', () => {
  it('prepends anchor when first point is not (0, 5.0)', () => {
    const input: DataPoint[] = [{ t: 5, s: 7 }]
    expect(prependNeutralAnchor(input)).toEqual([
      { t: 0, s: 5.0 },
      { t: 5, s: 7 },
    ])
  })
  it('returns input unchanged when first point is already (0, 5.0)', () => {
    const input: DataPoint[] = [
      { t: 0, s: 5.0 },
      { t: 5, s: 7 },
    ]
    expect(prependNeutralAnchor(input)).toEqual([
      { t: 0, s: 5.0 },
      { t: 5, s: 7 },
    ])
  })
})

describe('renderGraph', () => {
  const SAMPLE: DataPoint[] = [
    { t: 5, s: 7.8 },
    { t: 15, s: 7.2 },
    { t: 25, s: 6.8 },
    { t: 35, s: 7.5 },
    { t: 45, s: 8.1 },
    { t: 55, s: 9.2 },
  ]

  it('returns svg string and png Buffer for 4x5 without highlight', () => {
    const out = renderGraph({
      dataPoints: SAMPLE,
      totalRuntime: 60,
      criticsScore: 8.1,
      width: 1080,
      height: 540,
      format: '4x5',
    })
    expect(typeof out.svg).toBe('string')
    expect(out.svg.startsWith('<svg')).toBe(true)
    expect(Buffer.isBuffer(out.png)).toBe(true)
    expect(out.png.length).toBeGreaterThan(0)
  })

  it('returns svg string and png Buffer for 9x16 with highlight', () => {
    const out = renderGraph({
      dataPoints: SAMPLE,
      totalRuntime: 60,
      criticsScore: 8.1,
      width: 1080,
      height: 1152,
      format: '9x16',
      highlightBeatIndex: 6,
    })
    expect(typeof out.svg).toBe('string')
    expect(out.svg.startsWith('<svg')).toBe(true)
    expect(Buffer.isBuffer(out.png)).toBe(true)
    expect(out.png.length).toBeGreaterThan(0)
  })

  it('does not throw on valid PHM-shaped input', () => {
    const phm: DataPoint[] = [
      { t: 5, s: 7.8 },
      { t: 15, s: 7.2 },
      { t: 25, s: 6.8 },
      { t: 35, s: 7.5 },
      { t: 45, s: 7.9 },
      { t: 55, s: 8.1 },
      { t: 65, s: 6.2 },
      { t: 75, s: 5.8 },
      { t: 85, s: 8.7 },
      { t: 95, s: 9.2 },
      { t: 105, s: 8.9 },
      { t: 115, s: 9.5 },
      { t: 125, s: 8.6 },
      { t: 135, s: 9.1 },
      { t: 145, s: 8.8 },
      { t: 154, s: 7.4 },
    ]
    expect(() =>
      renderGraph({
        dataPoints: phm,
        totalRuntime: 157,
        criticsScore: 8.3,
        width: 1080,
        height: 540,
        format: '4x5',
        highlightBeatIndex: 12,
      }),
    ).not.toThrow()
  })

  it('exposes dotPositions aligned with the post-anchor point order', () => {
    const phm: DataPoint[] = [
      { t: 5, s: 7.8 },
      { t: 15, s: 7.2 },
      { t: 25, s: 6.8 },
      { t: 35, s: 7.5 },
      { t: 45, s: 7.9 },
      { t: 55, s: 8.1 },
      { t: 65, s: 6.2 },
      { t: 75, s: 5.8 },
      { t: 85, s: 8.7 },
      { t: 95, s: 9.2 },
      { t: 105, s: 8.9 },
      { t: 115, s: 9.5 },
      { t: 125, s: 8.6 },
      { t: 135, s: 9.1 },
      { t: 145, s: 8.8 },
      { t: 154, s: 7.4 },
    ]
    const width = 1080
    const height = 540
    const out = renderGraph({
      dataPoints: phm,
      totalRuntime: 157,
      criticsScore: 8.3,
      width,
      height,
      format: '4x5',
    })

    // Length is PHM count + 1 neutral anchor.
    expect(out.dotPositions.length).toBe(phm.length + 1)

    // Index 0 is the neutral anchor at t=0, s=5.0.
    expect(out.dotPositions[0].timestamp).toBe(0)
    expect(out.dotPositions[0].score).toBe(5.0)

    // Index 12 is the peak at t=115, s=9.5 (teal).
    expect(out.dotPositions[12].timestamp).toBe(115)
    expect(out.dotPositions[12].score).toBe(9.5)
    expect(out.dotPositions[12].color).toBe('teal')

    // Every position is a finite number inside the canvas bounds.
    for (const d of out.dotPositions) {
      expect(Number.isFinite(d.x)).toBe(true)
      expect(Number.isFinite(d.y)).toBe(true)
      expect(d.x).toBeGreaterThanOrEqual(0)
      expect(d.x).toBeLessThanOrEqual(width)
      expect(d.y).toBeGreaterThanOrEqual(0)
      expect(d.y).toBeLessThanOrEqual(height)
    }
  })
})
