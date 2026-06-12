import { describe, it, expect } from 'vitest'
import {
  seedWeight,
  scoreCandidates,
  preferredArcTags,
  applyArcBoost,
  applyQualityWeight,
  SEED_WEIGHT_FLOOR,
  ARC_SEED_MIN_RATING,
  ARC_BOOST_CAP,
} from '@/lib/recommendations'

describe('seedWeight', () => {
  it('returns 0 at the floor rating of 5', () => {
    expect(seedWeight(5)).toBe(0)
  })

  it('returns 1 at rating 6', () => {
    expect(seedWeight(6)).toBe(1)
  })

  it('returns 5 at rating 10', () => {
    expect(seedWeight(10)).toBe(5)
  })

  it('never goes negative below the floor', () => {
    expect(seedWeight(3)).toBe(0)
  })
})

describe('scoreCandidates', () => {
  it('excludes reviewed targets entirely', () => {
    const seeds = [{ filmId: 's1', overallRating: 9 }]
    const edges = [
      { filmId: 's1', similarFilmId: 'reviewed', similarityScore: 0.9 },
      { filmId: 's1', similarFilmId: 'fresh', similarityScore: 0.5 },
    ]
    const totals = scoreCandidates(seeds, edges, new Set(['s1', 'reviewed']))
    expect(totals.has('reviewed')).toBe(false)
    expect(totals.get('fresh')).toBeCloseTo(4 * 0.5)
  })

  it('accumulates across multiple seeds pointing at the same target, weighted correctly', () => {
    const seeds = [
      { filmId: 's1', overallRating: 8 }, // weight 3
      { filmId: 's2', overallRating: 7 }, // weight 2
    ]
    const edges = [
      { filmId: 's1', similarFilmId: 't', similarityScore: 0.5 },
      { filmId: 's2', similarFilmId: 't', similarityScore: 0.4 },
    ]
    const totals = scoreCandidates(seeds, edges, new Set())
    expect(totals.get('t')).toBeCloseTo(3 * 0.5 + 2 * 0.4)
  })

  it('seeds rated at or below the floor contribute nothing', () => {
    const seeds = [
      { filmId: 's1', overallRating: SEED_WEIGHT_FLOOR },
      { filmId: 's2', overallRating: 4 },
    ]
    const edges = [
      { filmId: 's1', similarFilmId: 't', similarityScore: 0.9 },
      { filmId: 's2', similarFilmId: 't', similarityScore: 0.9 },
    ]
    const totals = scoreCandidates(seeds, edges, new Set())
    expect(totals.size).toBe(0)
  })

  it('ignores edges whose source is not a seed', () => {
    const seeds = [{ filmId: 's1', overallRating: 8 }]
    const edges = [{ filmId: 'stranger', similarFilmId: 't', similarityScore: 0.9 }]
    const totals = scoreCandidates(seeds, edges, new Set())
    expect(totals.size).toBe(0)
  })
})

describe('preferredArcTags', () => {
  it('ignores seeds rated below ARC_SEED_MIN_RATING', () => {
    const tags = preferredArcTags([
      { filmId: 's1', overallRating: ARC_SEED_MIN_RATING - 0.5, arcShape: ['nosedive'] },
      { filmId: 's2', overallRating: ARC_SEED_MIN_RATING, arcShape: ['slow burn'] },
    ])
    expect(tags).toEqual(new Set(['slow burn']))
  })

  it('unions tags across qualifying seeds', () => {
    const tags = preferredArcTags([
      { filmId: 's1', overallRating: 9, arcShape: ['slow burn', 'perfect ending'] },
      { filmId: 's2', overallRating: 8, arcShape: ['perfect ending', 'steady great'] },
    ])
    expect(tags).toEqual(new Set(['slow burn', 'perfect ending', 'steady great']))
  })

  it('returns an empty set when no seed qualifies', () => {
    expect(preferredArcTags([])).toEqual(new Set())
  })
})

describe('applyArcBoost', () => {
  it('caps the boost at ARC_BOOST_CAP with 3+ matching tags', () => {
    const preferred = new Set(['slow burn', 'perfect ending', 'steady great'])
    const boosted = applyArcBoost(
      10,
      ['slow burn', 'perfect ending', 'steady great'],
      preferred,
    )
    expect(boosted).toBeCloseTo(10 * (1 + ARC_BOOST_CAP))
  })

  it('returns baseScore unchanged with zero matching tags', () => {
    expect(applyArcBoost(7.3, ['nosedive'], new Set(['slow burn']))).toBe(7.3)
    expect(applyArcBoost(7.3, [], new Set(['slow burn']))).toBe(7.3)
  })

  it('applies a single uncapped step for one matching tag', () => {
    expect(applyArcBoost(10, ['slow burn'], new Set(['slow burn']))).toBeCloseTo(11)
  })
})

describe('applyQualityWeight', () => {
  it('returns rankScore unchanged at sentiment 10', () => {
    expect(applyQualityWeight(13.2, 10)).toBeCloseTo(13.2)
  })

  it('halves rankScore at sentiment 5', () => {
    expect(applyQualityWeight(13.2, 5)).toBeCloseTo(6.6)
  })

  it('zeroes rankScore at sentiment 0', () => {
    expect(applyQualityWeight(13.2, 0)).toBe(0)
  })

  it('ranks a high-similarity low-quality candidate below a moderate-similarity high-quality one (the Eragon case)', () => {
    // From the first live diagnostic: Eragon (high base score, weak sentiment)
    // outranked The Two Towers (moderate base score, strong sentiment).
    const eragon = applyQualityWeight(13.2, 4.5)
    const twoTowers = applyQualityWeight(11.6, 8.7)
    expect(eragon).toBeLessThan(twoTowers)
  })
})
