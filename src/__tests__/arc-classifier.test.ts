import { describe, it, expect } from 'vitest'
import {
  classifyArcShape,
  ARC_SHAPES,
  ARC_MIN_BEATS,
  type ArcShape,
  type ClassifierBeat,
} from '@/lib/arc-classifier'

// Build evenly-spaced beats (t = 10, 20, 30, ...) from a score list. With this
// spacing the peak position is index/(n-1): idx0=0, idx1=0.25, ... idx4=1.0.
function pts(scores: number[], start = 10, step = 10): ClassifierBeat[] {
  return scores.map((s, i) => ({ timeMidpoint: start + i * step, score: s }))
}

describe('classifyArcShape', () => {
  it('perfect ending + slow burn co-occur on a steady climb to a final peak', () => {
    // mean 7, final 9 is the max and 2 above mean; monotonic rise.
    const tags = classifyArcShape(pts([5, 6, 7, 8, 9]), 9)
    expect(tags).toEqual(['slow burn', 'perfect ending'])
  })

  it('slow burn without perfect ending when the final beat is not the max', () => {
    const tags = classifyArcShape(pts([5, 5.5, 7.0, 6.0, 6.8]), 6)
    expect(tags).toEqual(['slow burn'])
  })

  it('hidden peak: mid-runtime peak with a fall to the end', () => {
    const tags = classifyArcShape(pts([6, 7, 9, 7, 6]), 7)
    expect(tags).toEqual(['hidden peak'])
  })

  it('hidden peak + nosedive co-occur (opens near max, mid peak, big fall)', () => {
    const tags = classifyArcShape(pts([9.0, 8.2, 9.1, 5.0, 4.0]), 7)
    expect(tags).toEqual(['hidden peak', 'nosedive'])
  })

  it('steady great: high overall score with a tight peak-low band', () => {
    const tags = classifyArcShape(pts([7.6, 8.0, 7.8, 8.2, 7.9]), 7.9)
    expect(tags).toEqual(['steady great'])
  })

  it('nosedive: opens at the max then falls steadily', () => {
    const tags = classifyArcShape(pts([9, 8, 6, 5, 4]), 6.4)
    expect(tags).toEqual(['nosedive'])
  })

  it('slow burn and nosedive are mutually exclusive', () => {
    const burn = classifyArcShape(pts([5, 6, 7, 8, 9]), 9)
    const dive = classifyArcShape(pts([9, 8, 6, 5, 4]), 6.4)
    expect(burn).toContain('slow burn')
    expect(burn).not.toContain('nosedive')
    expect(dive).toContain('nosedive')
    expect(dive).not.toContain('slow burn')
  })

  it('sorts internally: unsorted input yields the same tags as sorted', () => {
    const sorted = pts([5, 6, 7, 8, 9])
    const shuffled = [sorted[3], sorted[0], sorted[4], sorted[1], sorted[2]]
    expect(classifyArcShape(shuffled, 9)).toEqual(classifyArcShape(sorted, 9))
    expect(classifyArcShape(shuffled, 9)).toEqual(['slow burn', 'perfect ending'])
  })

  it('null/undefined overallScore disables only steady great', () => {
    // Same beats as the steady-great case, but no headline score -> no tag.
    expect(classifyArcShape(pts([7.6, 8.0, 7.8, 8.2, 7.9]), null)).toEqual([])
    // Other rules are unaffected by a missing overallScore.
    expect(classifyArcShape(pts([9, 8, 6, 5, 4]), undefined)).toEqual(['nosedive'])
  })

  it('returns no tags below the minimum beat count', () => {
    expect(classifyArcShape([], 9)).toEqual([])
    expect(classifyArcShape(pts([8]), 9)).toEqual([])
    expect(ARC_MIN_BEATS).toBe(2)
  })

  it('drops malformed beats before classifying', () => {
    const dirty = [
      { timeMidpoint: 10, score: 5 },
      { timeMidpoint: Number.NaN, score: 6 },
      { timeMidpoint: 30, score: Number.POSITIVE_INFINITY },
      { timeMidpoint: 40, score: 8 },
      { timeMidpoint: 50, score: 9 },
    ] as ClassifierBeat[]
    // Valid beats: (10,5),(40,8),(50,9) -> net rise, monotonic -> slow burn,
    // and 9 is the final max above mean -> perfect ending.
    expect(classifyArcShape(dirty, 9)).toEqual(['slow burn', 'perfect ending'])
  })

  it('always returns tags in canonical ARC_SHAPES order', () => {
    const tags = classifyArcShape(pts([9.0, 8.2, 9.1, 5.0, 4.0]), 7)
    const indices = tags.map((t: ArcShape) => ARC_SHAPES.indexOf(t))
    const ascending = [...indices].sort((a, b) => a - b)
    expect(indices).toEqual(ascending)
  })
})
