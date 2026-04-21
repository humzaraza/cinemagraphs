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

  describe('score overlay collision avoidance', () => {
    it('moves score to opposite corner (top-left) when 4x5 default top-right box collides with a late peak', () => {
      // Late peak at t=145, s=9.8 with runtime=157. At width=960 the peak
      // projects to roughly (861, 75), inside the default box
      // [780, 940] x [10, 90]. The opposite box [20, 180] x [10, 90] is
      // clear because all other points project to the bottom half of the plot.
      const latePeak: DataPoint[] = [
        { t: 10, s: 5.0 },
        { t: 50, s: 7.0 },
        { t: 90, s: 8.0 },
        { t: 120, s: 8.5 },
        { t: 145, s: 9.8 },
      ]
      const out = renderGraph({
        dataPoints: latePeak,
        totalRuntime: 157,
        criticsScore: 9.0,
        width: 960,
        height: 540,
        format: '4x5',
      })
      // Opposite corner rendering: x=100 (top-left).
      expect(out.svg).toContain('x="100" y="20"')
      expect(out.svg).toContain('x="100" y="56"')
      // Default corner (top-right at x=900) must not be used.
      expect(out.svg).not.toContain('x="900" y="20"')
    })

    it('keeps score in default corner (top-right) when no curve points collide (4x5)', () => {
      // All-low data — scores never rise into the top-right box.
      const flatLow: DataPoint[] = [
        { t: 20, s: 4.0 },
        { t: 60, s: 4.5 },
        { t: 100, s: 4.2 },
        { t: 140, s: 4.3 },
      ]
      const out = renderGraph({
        dataPoints: flatLow,
        totalRuntime: 157,
        criticsScore: 4.0,
        width: 960,
        height: 540,
        format: '4x5',
      })
      // Default corner: x = width - 60 = 900.
      expect(out.svg).toContain('x="900" y="20"')
      expect(out.svg).toContain('x="900" y="56"')
      // Opposite corner (x=100) must not be used.
      expect(out.svg).not.toContain('x="100" y="20"')
    })

    it('keeps score in default corner (top-left) for 9x16 when no curve points collide', () => {
      const phm: DataPoint[] = [
        { t: 5, s: 7.8 },
        { t: 55, s: 8.1 },
        { t: 115, s: 9.5 },
        { t: 154, s: 7.4 },
      ]
      const out = renderGraph({
        dataPoints: phm,
        totalRuntime: 157,
        criticsScore: 8.3,
        width: 1080,
        height: 1152,
        format: '9x16',
      })
      // Default 9x16: x=54 with text-anchor="start".
      expect(out.svg).toContain('x="54" y="40"')
      expect(out.svg).toContain('text-anchor="start"')
      // Opposite 9x16: x=width-54=1026 with text-anchor="end" — must not appear.
      expect(out.svg).not.toContain('x="1026" y="40"')
    })
  })

  describe('main-line stroke widths', () => {
    it('renders the main curve stroke at 4px and the glow stroke at 9px', () => {
      const out = renderGraph({
        dataPoints: SAMPLE,
        totalRuntime: 60,
        criticsScore: 8.1,
        width: 960,
        height: 540,
        format: '4x5',
      })
      expect(out.svg).toContain('stroke-width="9"')
      expect(out.svg).toContain('stroke-width="4"')
      expect(out.svg).not.toContain('stroke-width="2.5"')
      expect(out.svg).not.toContain('stroke-width="8"')
    })
  })

  describe('minimal mode', () => {
    it('returns a non-empty PNG buffer at 240x80 without crashing', () => {
      const out = renderGraph({
        dataPoints: SAMPLE,
        totalRuntime: 60,
        criticsScore: 8.1,
        width: 240,
        height: 80,
        format: '4x5',
        minimal: true,
      })
      expect(Buffer.isBuffer(out.png)).toBe(true)
      expect(out.png.length).toBeGreaterThan(0)
    })

    it('produces SVG without "Critics" label or score value when minimal: true', () => {
      const out = renderGraph({
        dataPoints: SAMPLE,
        totalRuntime: 60,
        criticsScore: 8.3,
        width: 240,
        height: 80,
        format: '4x5',
        minimal: true,
      })
      expect(out.svg).not.toContain('Critics')
      expect(out.svg).not.toContain('8.3')
    })

    it('still contains "Critics" and score when minimal is false', () => {
      const out = renderGraph({
        dataPoints: SAMPLE,
        totalRuntime: 60,
        criticsScore: 8.3,
        width: 1080,
        height: 540,
        format: '4x5',
        minimal: false,
      })
      expect(out.svg).toContain('Critics')
      expect(out.svg).toContain('8.3')
    })

    it('still contains "Critics" and score when minimal is undefined', () => {
      const out = renderGraph({
        dataPoints: SAMPLE,
        totalRuntime: 60,
        criticsScore: 8.3,
        width: 1080,
        height: 540,
        format: '4x5',
      })
      expect(out.svg).toContain('Critics')
      expect(out.svg).toContain('8.3')
    })

    it('returns dotPositions in minimal mode aligned with the post-anchor point order', () => {
      const width = 240
      const height = 80
      const out = renderGraph({
        dataPoints: SAMPLE,
        totalRuntime: 60,
        criticsScore: 8.1,
        width,
        height,
        format: '4x5',
        minimal: true,
      })
      expect(out.dotPositions.length).toBe(SAMPLE.length + 1)
      expect(out.dotPositions[0].timestamp).toBe(0)
      expect(out.dotPositions[0].score).toBe(5.0)
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
})
