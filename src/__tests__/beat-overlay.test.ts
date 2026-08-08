import { describe, it, expect } from 'vitest'
import { buildBeatOverlay, type BeatOverlayGeometry } from '@/lib/beat-overlay'

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
