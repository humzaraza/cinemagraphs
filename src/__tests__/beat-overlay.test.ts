import { describe, it, expect } from 'vitest'
import { buildBeatOverlay, hasDrawableArc, type BeatOverlayGeometry } from '@/lib/beat-overlay'

// Fixture shape verified against both real callers: SentimentDataPoint in
// src/lib/types.ts (label: string, score: number, plus timing fields) and
// the profile page's local DataPoint interface (same label and score fields).
// buildBeatOverlay only reads label and score, so these hand-built fixtures
// are structurally valid inputs for both.

const GEOMETRY: BeatOverlayGeometry = { width: 600, height: 120, padding: 6 }

function beats(scores: number[]): { label: string; score: number }[] {
  return scores.map((score, i) => ({ label: `Beat ${i + 1}`, score }))
}

// Mirrors of the coordinate math under test, for computing expected values.
function xAt(i: number, total: number, g: BeatOverlayGeometry = GEOMETRY): number {
  return g.padding + (i / Math.max(total - 1, 1)) * (g.width - g.padding * 2)
}
function yAt(value: number, g: BeatOverlayGeometry = GEOMETRY): number {
  return g.height - g.padding - ((value - 1) / 9) * (g.height - g.padding * 2)
}

describe('buildBeatOverlay', () => {
  it('all beats rated: exactly one run and one dot per beat', () => {
    const dataPoints = beats([5, 6, 7, 8])
    const ratings = { 'Beat 1': 4, 'Beat 2': 5, 'Beat 3': 6, 'Beat 4': 7 }
    const result = buildBeatOverlay(dataPoints, ratings, GEOMETRY)

    expect(result.ratedRuns).toHaveLength(1)
    expect(result.dots).toHaveLength(4)
    expect(result.ratedCount).toBe(4)
    expect(result.totalBeats).toBe(4)
    expect(result.ratedRuns[0]).toBe(
      [4, 5, 6, 7]
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i, 4)},${yAt(v)}`)
        .join(' ')
    )
  })

  it('two runs separated by one unrated beat: two run paths, correct dot count', () => {
    const dataPoints = beats([5, 6, 7, 8, 9])
    // Beat 3 unrated: runs are indices 0-1 and 3-4.
    const ratings = { 'Beat 1': 4, 'Beat 2': 5, 'Beat 4': 6, 'Beat 5': 7 }
    const result = buildBeatOverlay(dataPoints, ratings, GEOMETRY)

    expect(result.ratedRuns).toHaveLength(2)
    expect(result.dots).toHaveLength(4)
    expect(result.ratedCount).toBe(4)
    expect(result.ratedRuns[0]).toBe(`M${xAt(0, 5)},${yAt(4)} L${xAt(1, 5)},${yAt(5)}`)
    expect(result.ratedRuns[1]).toBe(`M${xAt(3, 5)},${yAt(6)} L${xAt(4, 5)},${yAt(7)}`)
  })

  it('a single isolated rated beat: zero run paths, one dot', () => {
    const dataPoints = beats([5, 6, 7, 8])
    const ratings = { 'Beat 2': 9 }
    const result = buildBeatOverlay(dataPoints, ratings, GEOMETRY)

    expect(result.ratedRuns).toHaveLength(0)
    expect(result.dots).toEqual([{ x: xAt(1, 4), y: yAt(9) }])
    expect(result.ratedCount).toBe(1)
  })

  it('one run plus one isolated beat: one run path, dots for every rated beat', () => {
    const dataPoints = beats([5, 6, 7, 8, 9, 4])
    // Indices 0-1 form a run; index 4 is isolated (3 and 5 unrated).
    const ratings = { 'Beat 1': 3, 'Beat 2': 4, 'Beat 5': 8 }
    const result = buildBeatOverlay(dataPoints, ratings, GEOMETRY)

    expect(result.ratedRuns).toHaveLength(1)
    expect(result.ratedRuns[0]).toBe(`M${xAt(0, 6)},${yAt(3)} L${xAt(1, 6)},${yAt(4)}`)
    expect(result.dots).toEqual([
      { x: xAt(0, 6), y: yAt(3) },
      { x: xAt(1, 6), y: yAt(4) },
      { x: xAt(4, 6), y: yAt(8) },
    ])
    expect(result.ratedCount).toBe(3)
  })

  it('beatRatings null: empty runs, empty dots, goldPath still built', () => {
    const dataPoints = beats([2, 8, 5])
    const result = buildBeatOverlay(dataPoints, null, GEOMETRY)

    expect(result.ratedRuns).toEqual([])
    expect(result.dots).toEqual([])
    expect(result.ratedCount).toBe(0)
    expect(result.totalBeats).toBe(3)
    expect(result.goldPath).toBe(
      [2, 8, 5]
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i, 3)},${yAt(v)}`)
        .join(' ')
    )
  })

  it('beatRatings {}: same as null', () => {
    const dataPoints = beats([2, 8, 5])
    const withNull = buildBeatOverlay(dataPoints, null, GEOMETRY)
    const withEmpty = buildBeatOverlay(dataPoints, {}, GEOMETRY)

    expect(withEmpty).toEqual(withNull)
    expect(withEmpty.goldPath.length).toBeGreaterThan(0)
  })

  it('a beatRatings key matching no dataPoint label: ignored, no dot, no crash', () => {
    const dataPoints = beats([5, 6, 7])
    const ratings = { 'Beat 2': 6, 'Not A Real Beat': 10 }
    const result = buildBeatOverlay(dataPoints, ratings, GEOMETRY)

    expect(result.ratedCount).toBe(1)
    expect(result.dots).toEqual([{ x: xAt(1, 3), y: yAt(6) }])
    expect(result.ratedRuns).toHaveLength(0)
  })

  it('keys x on the dataPoints index, not the rated subset', () => {
    const dataPoints = beats([5, 6, 7, 8, 9, 8, 7, 6])
    const expectedX = xAt(7, 8)

    // Only the last beat rated: it is the sole dot.
    const sparse = buildBeatOverlay(dataPoints, { 'Beat 8': 5 }, GEOMETRY)
    expect(sparse.dots).toHaveLength(1)
    expect(sparse.dots[0].x).toBe(expectedX)

    // Every beat rated: the same beat is now the eighth dot, at the same x.
    const dense = buildBeatOverlay(
      dataPoints,
      {
        'Beat 1': 5,
        'Beat 2': 5,
        'Beat 3': 5,
        'Beat 4': 5,
        'Beat 5': 5,
        'Beat 6': 5,
        'Beat 7': 5,
        'Beat 8': 5,
      },
      GEOMETRY
    )
    expect(dense.dots).toHaveLength(8)
    expect(dense.dots[7].x).toBe(expectedX)
  })

  it('first and last beat rated with nothing between: zero run paths, two dots', () => {
    const dataPoints = beats([5, 6, 7, 8])
    const ratings = { 'Beat 1': 2, 'Beat 4': 9 }
    const result = buildBeatOverlay(dataPoints, ratings, GEOMETRY)

    expect(result.ratedRuns).toHaveLength(0)
    expect(result.dots).toEqual([
      { x: xAt(0, 4), y: yAt(2) },
      { x: xAt(3, 4), y: yAt(9) },
    ])
    expect(result.ratedCount).toBe(2)
  })
})

// ── Extended geometry: per-side padding, custom y range, time-based x, runs ──

// Mirror math for the generalized geometry, kept separate from the legacy
// helpers above so the original cases stay byte-for-byte untouched.
interface SidePad {
  top: number
  right: number
  bottom: number
  left: number
}
function xAtPadded(i: number, total: number, width: number, pad: SidePad): number {
  return pad.left + (i / Math.max(total - 1, 1)) * (width - pad.left - pad.right)
}
function xAtTime(
  timeMidpoint: number,
  runtimeMinutes: number,
  width: number,
  pad: SidePad
): number {
  const clamped = Math.min(Math.max(timeMidpoint / runtimeMinutes, 0), 1)
  return pad.left + clamped * (width - pad.left - pad.right)
}
function yAtRange(
  value: number,
  height: number,
  pad: SidePad,
  yFloor: number,
  yCeiling: number
): number {
  return (
    height - pad.bottom - ((value - yFloor) / (yCeiling - yFloor)) * (height - pad.top - pad.bottom)
  )
}

function timedBeats(
  entries: { score: number; timeMidpoint?: number }[]
): { label: string; score: number; timeMidpoint?: number }[] {
  return entries.map((e, i) => ({ label: `Beat ${i + 1}`, ...e }))
}

describe('buildBeatOverlay extended geometry', () => {
  const PAD: SidePad = { top: 14, right: 12, bottom: 6, left: 12 }

  it('per-side padding produces the expected drawable box', () => {
    const dataPoints = beats([5, 6, 7])
    const ratings = { 'Beat 1': 1, 'Beat 2': 5, 'Beat 3': 10 }
    const geometry = { width: 600, height: 120, padding: PAD }
    const result = buildBeatOverlay(dataPoints, ratings, geometry)

    // Left and right edges of the drawable box.
    expect(result.dots[0].x).toBe(12)
    expect(result.dots[2].x).toBe(600 - 12)
    // Score 1 (default floor) maps to the bottom pad, 10 to the top pad.
    expect(result.dots[0].y).toBe(120 - 6)
    expect(result.dots[2].y).toBe(14)
    expect(result.dots[1].x).toBe(xAtPadded(1, 3, 600, PAD))
    expect(result.dots[1].y).toBe(yAtRange(5, 120, PAD, 1, 10))
  })

  it('a custom yFloor changes y as expected', () => {
    const dataPoints = beats([5, 6, 7])
    const ratings = { 'Beat 1': 5, 'Beat 2': 7.5, 'Beat 3': 10 }
    const uniform: SidePad = { top: 6, right: 6, bottom: 6, left: 6 }
    const result = buildBeatOverlay(dataPoints, ratings, {
      width: 600,
      height: 120,
      padding: 6,
      yFloor: 5,
      yCeiling: 10,
    })

    // The floor score now sits at the bottom of the drawable box and the
    // midpoint of the range sits halfway up it.
    expect(result.dots[0].y).toBe(120 - 6)
    expect(result.dots[1].y).toBe(yAtRange(7.5, 120, uniform, 5, 10))
    expect(result.dots[1].y).toBe(6 + (120 - 12) / 2)
    expect(result.dots[2].y).toBe(6)
  })

  it('explicit yFloor 1 and yCeiling 10 match the default output exactly', () => {
    const dataPoints = beats([2, 8, 5, 9])
    const ratings = { 'Beat 1': 3, 'Beat 2': 7, 'Beat 4': 10 }
    const withDefaults = buildBeatOverlay(dataPoints, ratings, GEOMETRY)
    const explicit = buildBeatOverlay(dataPoints, ratings, {
      ...GEOMETRY,
      yFloor: 1,
      yCeiling: 10,
    })

    expect(explicit).toEqual(withDefaults)
  })

  it('time-based x places a beat at its runtime fraction, not its index', () => {
    const dataPoints = timedBeats([
      { score: 5, timeMidpoint: 22.5 },
      { score: 6, timeMidpoint: 60 },
      { score: 7, timeMidpoint: 110 },
    ])
    const ratings = { 'Beat 1': 4, 'Beat 2': 6, 'Beat 3': 8 }
    const geometry = { width: 600, height: 120, padding: PAD, runtimeMinutes: 120 }
    const result = buildBeatOverlay(dataPoints, ratings, geometry)

    expect(result.dots[0].x).toBe(xAtTime(22.5, 120, 600, PAD))
    expect(result.dots[0].x).toBe(12 + (22.5 / 120) * (600 - 24))
    expect(result.dots[0].x).not.toBe(xAtPadded(0, 3, 600, PAD))
    expect(result.dots[1].x).toBe(xAtTime(60, 120, 600, PAD))
    expect(result.dots[2].x).toBe(xAtTime(110, 120, 600, PAD))
  })

  it('time-based x clamps a midpoint outside the runtime to the drawable range', () => {
    const dataPoints = timedBeats([
      { score: 5, timeMidpoint: -3 },
      { score: 6, timeMidpoint: 130 },
    ])
    const ratings = { 'Beat 1': 4, 'Beat 2': 6 }
    const geometry = { width: 600, height: 120, padding: PAD, runtimeMinutes: 120 }
    const result = buildBeatOverlay(dataPoints, ratings, geometry)

    expect(result.dots[0].x).toBe(12)
    expect(result.dots[1].x).toBe(600 - 12)
  })

  const badRuntimes: [string, number | undefined][] = [
    ['absent', undefined],
    ['zero', 0],
    ['negative', -90],
  ]
  it.each(badRuntimes)('falls back to index spacing when runtimeMinutes is %s', (_name, runtimeMinutes) => {
    const dataPoints = timedBeats([
      { score: 5, timeMidpoint: 22.5 },
      { score: 6, timeMidpoint: 60 },
      { score: 7, timeMidpoint: 110 },
    ])
    const ratings = { 'Beat 1': 4, 'Beat 2': 6, 'Beat 3': 8 }
    const result = buildBeatOverlay(dataPoints, ratings, {
      width: 600,
      height: 120,
      padding: PAD,
      runtimeMinutes,
    })

    expect(result.dots.map((d) => d.x)).toEqual([
      xAtPadded(0, 3, 600, PAD),
      xAtPadded(1, 3, 600, PAD),
      xAtPadded(2, 3, 600, PAD),
    ])
  })

  const badMidpoints: [string, number | undefined][] = [
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['non-numeric', 'forty-two' as unknown as number],
  ]
  it.each(badMidpoints)('falls back to index spacing when any timeMidpoint is %s', (_name, badMidpoint) => {
    const dataPoints = timedBeats([
      { score: 5, timeMidpoint: 22.5 },
      { score: 6, timeMidpoint: badMidpoint },
      { score: 7, timeMidpoint: 110 },
    ])
    const ratings = { 'Beat 1': 4, 'Beat 2': 6, 'Beat 3': 8 }
    const result = buildBeatOverlay(dataPoints, ratings, {
      width: 600,
      height: 120,
      padding: PAD,
      runtimeMinutes: 120,
    })

    expect(result.dots.map((d) => d.x)).toEqual([
      xAtPadded(0, 3, 600, PAD),
      xAtPadded(1, 3, 600, PAD),
      xAtPadded(2, 3, 600, PAD),
    ])
  })

  it('runs groups consecutive rated beats into point arrays and ratedRuns matches', () => {
    const dataPoints = beats([5, 6, 7, 8, 9])
    // Beat 3 unrated: runs are indices 0-1 and 3-4.
    const ratings = { 'Beat 1': 4, 'Beat 2': 5, 'Beat 4': 6, 'Beat 5': 7 }
    const result = buildBeatOverlay(dataPoints, ratings, GEOMETRY)

    expect(result.runs).toEqual([
      [
        { x: xAt(0, 5), y: yAt(4) },
        { x: xAt(1, 5), y: yAt(5) },
      ],
      [
        { x: xAt(3, 5), y: yAt(6) },
        { x: xAt(4, 5), y: yAt(7) },
      ],
    ])
    expect(result.ratedRuns).toEqual(
      result.runs.map((run) =>
        run.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
      )
    )
  })

  it('a lone rated beat yields one dot and no run of length two or more', () => {
    const dataPoints = beats([5, 6, 7, 8])
    const ratings = { 'Beat 3': 9 }
    const result = buildBeatOverlay(dataPoints, ratings, GEOMETRY)

    expect(result.dots).toEqual([{ x: xAt(2, 4), y: yAt(9) }])
    expect(result.runs.every((run) => run.length < 2)).toBe(true)
    expect(result.ratedRuns).toHaveLength(0)
  })

  it('a run of two plus an isolated beat: runs holds both, ratedRuns only the pair', () => {
    const dataPoints = beats([5, 6, 7, 8, 9, 4])
    // Indices 0-1 form a run; index 4 is isolated (3 and 5 unrated).
    const ratings = { 'Beat 1': 3, 'Beat 2': 4, 'Beat 5': 8 }
    const result = buildBeatOverlay(dataPoints, ratings, GEOMETRY)

    expect(result.runs).toEqual([
      [
        { x: xAt(0, 6), y: yAt(3) },
        { x: xAt(1, 6), y: yAt(4) },
      ],
      [{ x: xAt(4, 6), y: yAt(8) }],
    ])
    expect(result.ratedRuns).toHaveLength(1)
  })
})

describe('hasDrawableArc', () => {
  it('two adjacent rated beats: true', () => {
    const dataPoints = beats([5, 6, 7, 8])
    expect(hasDrawableArc(dataPoints, { 'Beat 2': 6, 'Beat 3': 7 })).toBe(true)
  })

  it('two non-adjacent rated beats: false', () => {
    const dataPoints = beats([5, 6, 7, 8])
    expect(hasDrawableArc(dataPoints, { 'Beat 1': 2, 'Beat 4': 9 })).toBe(false)
  })

  it('one rated beat: false', () => {
    const dataPoints = beats([5, 6, 7, 8])
    expect(hasDrawableArc(dataPoints, { 'Beat 2': 9 })).toBe(false)
  })

  it('zero rated beats via null beatRatings: false', () => {
    expect(hasDrawableArc(beats([5, 6, 7]), null)).toBe(false)
  })

  it('undefined beatRatings: false', () => {
    expect(hasDrawableArc(beats([5, 6, 7]), undefined)).toBe(false)
  })

  it('empty beatRatings object: false', () => {
    expect(hasDrawableArc(beats([5, 6, 7]), {})).toBe(false)
  })

  it('null dataPoints: false', () => {
    expect(hasDrawableArc(null, { 'Beat 1': 5, 'Beat 2': 6 })).toBe(false)
  })

  it('undefined dataPoints: false', () => {
    expect(hasDrawableArc(undefined, { 'Beat 1': 5, 'Beat 2': 6 })).toBe(false)
  })

  it('empty dataPoints: false', () => {
    expect(hasDrawableArc([], { 'Beat 1': 5, 'Beat 2': 6 })).toBe(false)
  })

  it('rating labels matching no dataPoint: false', () => {
    const dataPoints = beats([5, 6, 7])
    expect(hasDrawableArc(dataPoints, { 'Not A Beat': 5, 'Also Not A Beat': 6 })).toBe(false)
  })

  it('a run of two plus an isolated beat: true', () => {
    const dataPoints = beats([5, 6, 7, 8, 9, 4])
    // Indices 0-1 form a run; index 4 is isolated (3 and 5 unrated).
    expect(hasDrawableArc(dataPoints, { 'Beat 1': 3, 'Beat 2': 4, 'Beat 5': 8 })).toBe(true)
  })

  it('all beats rated: true', () => {
    const dataPoints = beats([5, 6, 7, 8])
    expect(
      hasDrawableArc(dataPoints, { 'Beat 1': 4, 'Beat 2': 5, 'Beat 3': 6, 'Beat 4': 7 })
    ).toBe(true)
  })

  it('agrees with buildBeatOverlay: true exactly when a drawn run exists', () => {
    const cases: (Record<string, number> | null)[] = [
      { 'Beat 1': 4, 'Beat 2': 5 },
      { 'Beat 1': 2, 'Beat 4': 9 },
      { 'Beat 3': 9 },
      { 'Beat 1': 3, 'Beat 2': 4, 'Beat 4': 8 },
      {},
      null,
    ]
    const dataPoints = beats([5, 6, 7, 8])
    for (const ratings of cases) {
      const overlay = buildBeatOverlay(dataPoints, ratings, GEOMETRY)
      expect(hasDrawableArc(dataPoints, ratings)).toBe(overlay.ratedRuns.length > 0)
    }
  })
})
