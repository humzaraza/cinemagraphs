import { describe, it, expect, vi } from 'vitest'

// The share route imports auth, prisma, satori, sharp, and the TMDB image
// fetcher at module scope. None of them are exercised by the pure geometry
// helpers under test, so they are all stubbed out (same pattern as the other
// route tests in this directory).
vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/tmdb-image', () => ({ fetchTmdbImageAsDataUri: vi.fn() }))
vi.mock('satori', () => ({ default: vi.fn() }))
vi.mock('sharp', () => ({ default: vi.fn() }))

import {
  buildUserDataPoints,
  buildPosterGraph,
} from '@/app/api/share/review/[reviewId]/route'

// Poster graph paddings, mirrored from the route's constants.
const PAD_TOP = 14
const PAD_BOTTOM = 6
const PAD_LEFT = 12
const PAD_RIGHT = 12

const GW = 880
const GH = 480

function xTime(timeMidpoint: number, runtimeMin: number, gw: number = GW): number {
  const clamped = Math.min(Math.max(timeMidpoint / runtimeMin, 0), 1)
  return PAD_LEFT + clamped * (gw - PAD_LEFT - PAD_RIGHT)
}
function xIndex(i: number, total: number, gw: number = GW): number {
  return PAD_LEFT + (i / Math.max(total - 1, 1)) * (gw - PAD_LEFT - PAD_RIGHT)
}
function yScore(score: number, yFloor: number, gh: number = GH): number {
  return (
    gh - PAD_BOTTOM - ((score - yFloor) / (10 - yFloor)) * (gh - PAD_TOP - PAD_BOTTOM)
  )
}
function linePath(points: { x: number; y: number }[]): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ')
}
function fillPath(points: { x: number; y: number }[], gh: number = GH): string {
  const firstX = points[0].x
  const lastX = points[points.length - 1].x
  return `${linePath(points)} L${lastX.toFixed(1)},${gh.toFixed(1)} L${firstX.toFixed(1)},${gh.toFixed(1)} Z`
}

// An eight-beat film, 120 minutes.
const RUNTIME = 120
const MIDPOINTS = [5, 20, 35, 50, 65, 80, 95, 110]
const FILM_BEATS = MIDPOINTS.map((timeMidpoint, i) => ({
  label: `B${i + 1}`,
  score: 5 + (i % 3),
  timeMidpoint,
}))

describe('buildUserDataPoints', () => {
  it('keeps each rated beat with its score and timeMidpoint', () => {
    const ratings = { B1: 7.5, B5: 9.5 }
    const result = buildUserDataPoints(ratings, FILM_BEATS)

    expect(result).toEqual([
      { label: 'B1', score: 7.5, timeMidpoint: 5 },
      { label: 'B5', score: 9.5, timeMidpoint: 65 },
    ])
  })

  it('drops a legacy null rating instead of turning it into a coordinate', () => {
    const ratings = { B1: 7, B2: null, B3: 8 } as unknown as Record<string, number>
    const result = buildUserDataPoints(ratings, FILM_BEATS)

    expect(result.map((p) => p.label)).toEqual(['B1', 'B3'])
    expect(result.every((p) => typeof p.score === 'number')).toBe(true)
  })
})

describe('buildPosterGraph', () => {
  it('builds one line and one fill per run, none for gaps', () => {
    // Two runs: indices 0-1 and 3-4, with index 2 unrated between them.
    const ratings = { B1: 7.5, B2: 8, B4: 6, B5: 9 }
    const result = buildPosterGraph(FILM_BEATS, ratings, GW, GH, RUNTIME)

    expect(result.yFloor).toBe(5)
    expect(result.linePaths).toHaveLength(2)
    expect(result.fillPaths).toHaveLength(2)
    expect(result.dots).toHaveLength(4)
  })

  it('each fill closes at its own run endpoints, not at the graph edges', () => {
    const ratings = { B1: 7.5, B2: 8, B4: 6, B5: 9 }
    const { yFloor, fillPaths } = buildPosterGraph(FILM_BEATS, ratings, GW, GH, RUNTIME)

    const run1 = [
      { x: xTime(5, RUNTIME), y: yScore(7.5, yFloor) },
      { x: xTime(20, RUNTIME), y: yScore(8, yFloor) },
    ]
    const run2 = [
      { x: xTime(50, RUNTIME), y: yScore(6, yFloor) },
      { x: xTime(65, RUNTIME), y: yScore(9, yFloor) },
    ]
    expect(fillPaths[0]).toBe(fillPath(run1))
    expect(fillPaths[1]).toBe(fillPath(run2))

    // Neither fill touches the drawable box's left or right edge.
    const leftEdge = `L${PAD_LEFT.toFixed(1)},${GH.toFixed(1)}`
    const rightEdge = `L${(GW - PAD_RIGHT).toFixed(1)},${GH.toFixed(1)}`
    for (const fill of fillPaths) {
      expect(fill).not.toContain(leftEdge)
      expect(fill).not.toContain(rightEdge)
    }
  })

  it('lines match the fills run for run', () => {
    const ratings = { B1: 7.5, B2: 8, B4: 6, B5: 9 }
    const { yFloor, linePaths } = buildPosterGraph(FILM_BEATS, ratings, GW, GH, RUNTIME)

    expect(linePaths[0]).toBe(
      linePath([
        { x: xTime(5, RUNTIME), y: yScore(7.5, yFloor) },
        { x: xTime(20, RUNTIME), y: yScore(8, yFloor) },
      ])
    )
    expect(linePaths[1]).toBe(
      linePath([
        { x: xTime(50, RUNTIME), y: yScore(6, yFloor) },
        { x: xTime(65, RUNTIME), y: yScore(9, yFloor) },
      ])
    )
  })

  it('two isolated rated beats: dots only, no line, no fill', () => {
    // The seed-review-2 shape: first and fifth beats rated, nothing between.
    const ratings = { B1: 7.5, B5: 9.5 }
    const result = buildPosterGraph(FILM_BEATS, ratings, GW, GH, RUNTIME)

    expect(result.linePaths).toEqual([])
    expect(result.fillPaths).toEqual([])
    expect(result.dots).toHaveLength(2)
    expect(result.dots[0].x).toBeCloseTo(xTime(5, RUNTIME), 10)
    expect(result.dots[1].x).toBeCloseTo(xTime(65, RUNTIME), 10)
  })

  it('places a dot at its runtime fraction of the drawable width', () => {
    const filmBeats = [
      { label: 'B1', score: 5, timeMidpoint: 22.5 },
      { label: 'B2', score: 6, timeMidpoint: 60 },
      { label: 'B3', score: 7, timeMidpoint: 110 },
    ]
    const ratings = { B1: 8, B2: 7 }
    const result = buildPosterGraph(filmBeats, ratings, GW, GH, RUNTIME)

    expect(result.dots[0].x).toBeCloseTo(
      PAD_LEFT + (22.5 / RUNTIME) * (GW - PAD_LEFT - PAD_RIGHT),
      10
    )
    expect(result.dots[0].x).not.toBeCloseTo(xIndex(0, 3), 10)
  })

  it('falls back to index spacing when the film has no runtime', () => {
    const ratings = { B1: 7.5, B2: 8 }
    const result = buildPosterGraph(FILM_BEATS, ratings, GW, GH, null)

    expect(result.dots.map((d) => d.x)).toEqual([
      xIndex(0, FILM_BEATS.length),
      xIndex(1, FILM_BEATS.length),
    ])
  })
})
