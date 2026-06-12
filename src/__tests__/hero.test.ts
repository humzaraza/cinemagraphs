import { describe, it, expect, vi } from 'vitest'

// hero.ts imports @/lib/prisma at module load (Neon adapter). Mock it so these
// pure-function tests never construct a real client. The pure functions under
// test do not touch prisma.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import {
  heroDateParts,
  heroAngleForDayOfWeek,
  selectFromPool,
  pickDailyHero,
  HERO_RANKED_POOL_SIZE,
  HERO_NOSEDIVE_MIN_PEAK,
  type HeroAngle,
  type HeroCandidate,
} from '@/lib/hero'

const DAY = 86_400_000

function cand(over: Partial<HeroCandidate> & { id: string }): HeroCandidate {
  return {
    id: over.id,
    imdbVotes: over.imdbVotes ?? 100,
    beatCount: over.beatCount ?? 6,
    overallScore: over.overallScore ?? 8,
    swing: over.swing ?? 3,
    arcShape: over.arcShape ?? [],
    lastFeaturedAt: over.lastFeaturedAt ?? null,
    peakScore: over.peakScore ?? 8,
  }
}

// Find a mid-day instant whose HERO_TIMEZONE day-of-week is the target. Mid-day
// (17:00 UTC ~= 12-13:00 Toronto) avoids midnight-rollover ambiguity.
function nowForDow(targetDow: number): Date {
  const base = Date.UTC(2026, 0, 1, 17, 0, 0)
  for (let i = 0; i < 14; i++) {
    const now = new Date(base + i * DAY)
    if (heroDateParts(now).dayOfWeek === targetDow) return now
  }
  throw new Error(`no instant found for dow ${targetDow}`)
}

const RANKED_SCORE: HeroAngle = { kind: 'ranked', metric: 'overallScore', label: 'x' }
const RANKED_SWING: HeroAngle = { kind: 'ranked', metric: 'swing', label: 'x' }
const SHAPE_HIDDEN: HeroAngle = { kind: 'shape', shape: 'hidden peak', label: 'x' }

describe('heroDateParts', () => {
  it('resolves the local calendar date in HERO_TIMEZONE (handles UTC->local day shift)', () => {
    // 02:00 UTC on Jun 4 is still Jun 3, 22:00 in Toronto (UTC-4).
    expect(heroDateParts(new Date('2026-06-04T02:00:00Z')).day).toBe(3)
    // Midday UTC is unambiguously Jun 4 locally.
    expect(heroDateParts(new Date('2026-06-04T16:00:00Z')).day).toBe(4)
  })

  it('derives consistent dayNumber / dayOfYear / dayOfWeek across consecutive days', () => {
    const a = heroDateParts(new Date('2026-03-10T17:00:00Z'))
    const b = heroDateParts(new Date('2026-03-11T17:00:00Z'))
    expect(b.dayNumber - a.dayNumber).toBe(1)
    expect(b.dayOfYear - a.dayOfYear).toBe(1)
    expect((a.dayOfWeek + 1) % 7).toBe(b.dayOfWeek)
  })
})

describe('heroAngleForDayOfWeek', () => {
  it('maps each weekday to its angle', () => {
    expect(heroAngleForDayOfWeek(1)).toMatchObject({ kind: 'ranked', metric: 'overallScore' })
    expect(heroAngleForDayOfWeek(2)).toMatchObject({ kind: 'ranked', metric: 'swing' })
    expect(heroAngleForDayOfWeek(3)).toMatchObject({ kind: 'shape', shape: 'hidden peak' })
    expect(heroAngleForDayOfWeek(4)).toMatchObject({ kind: 'shape', shape: 'nosedive' })
    expect(heroAngleForDayOfWeek(5)).toMatchObject({ kind: 'shape', shape: 'perfect ending' })
    expect(heroAngleForDayOfWeek(6)).toMatchObject({ kind: 'shape', shape: 'slow burn' })
    expect(heroAngleForDayOfWeek(0)).toMatchObject({ kind: 'shape', shape: 'steady great' })
  })
})

describe('selectFromPool', () => {
  it('ranked: sorts by metric desc and indexes by dayOfYear', () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      cand({ id: `f${i}`, overallScore: 10 - i }),
    )
    expect(selectFromPool(pool, RANKED_SCORE, 0).id).toBe('f0') // highest score
    expect(selectFromPool(pool, RANKED_SCORE, 3).id).toBe('f3')
  })

  it('ranked: breaks score ties by film.id ascending', () => {
    const pool = [
      cand({ id: 'b', overallScore: 9 }),
      cand({ id: 'a', overallScore: 9 }),
      cand({ id: 'c', overallScore: 8 }),
    ]
    expect(selectFromPool(pool, RANKED_SCORE, 0).id).toBe('a')
  })

  it('ranked: caps the rotation pool at HERO_RANKED_POOL_SIZE', () => {
    const pool = Array.from({ length: 35 }, (_, i) =>
      cand({ id: `f${String(i).padStart(2, '0')}`, overallScore: 100 - i }),
    )
    // dayOfYear 33 -> 33 % 30 == 3 -> the 4th-highest within the capped top 30.
    expect(selectFromPool(pool, RANKED_SCORE, 33).id).toBe('f03')
    expect(HERO_RANKED_POOL_SIZE).toBe(30)
  })

  it('ranked: swing metric ranks by swing', () => {
    const pool = [
      cand({ id: 'a', swing: 1 }),
      cand({ id: 'b', swing: 7 }),
      cand({ id: 'c', swing: 4 }),
    ]
    expect(selectFromPool(pool, RANKED_SWING, 0).id).toBe('b')
  })

  it('shape: sorts by film.id ascending and indexes by dayOfYear', () => {
    const pool = [cand({ id: 'c' }), cand({ id: 'a' }), cand({ id: 'b' })]
    expect(selectFromPool(pool, SHAPE_HIDDEN, 0).id).toBe('a')
    expect(selectFromPool(pool, SHAPE_HIDDEN, 1).id).toBe('b')
    expect(selectFromPool(pool, SHAPE_HIDDEN, 5).id).toBe('c') // 5 % 3 == 2
  })
})

describe('pickDailyHero eligibility + guard', () => {
  const wed = nowForDow(3) // hidden peak day

  it('filters by votes, beat count, and angle match', () => {
    const candidates = [
      cand({ id: 'ok', arcShape: ['hidden peak'] }),
      cand({ id: 'few-votes', imdbVotes: 10, arcShape: ['hidden peak'] }),
      cand({ id: 'few-beats', beatCount: 4, arcShape: ['hidden peak'] }),
      cand({ id: 'wrong-tag', arcShape: ['nosedive'] }),
    ]
    const pick = pickDailyHero(candidates, wed)
    expect(pick?.angle).toMatchObject({ kind: 'shape', shape: 'hidden peak' })
    expect(pick?.film.id).toBe('ok')
    expect(pick?.usedFallback).toBe(false)
  })

  it('returns null when nothing matches the angle', () => {
    const candidates = [cand({ id: 'a', arcShape: ['nosedive'] })]
    expect(pickDailyHero(candidates, wed)).toBeNull()
  })

  it('excludes films featured in the last 14 days, keeps older / never', () => {
    const recent = new Date(wed.getTime() - 5 * DAY)
    const old = new Date(wed.getTime() - 20 * DAY)
    const candidates = [
      cand({ id: 'recent', arcShape: ['hidden peak'], lastFeaturedAt: recent }),
      cand({ id: 'old', arcShape: ['hidden peak'], lastFeaturedAt: old }),
    ]
    // 'recent' is guarded out; 'old' (20 days) is eligible.
    expect(pickDailyHero(candidates, wed)?.film.id).toBe('old')
  })

  it('falls back to the pre-guard set when the guard empties it', () => {
    const recent = new Date(wed.getTime() - 3 * DAY)
    const candidates = [
      cand({ id: 'a', arcShape: ['hidden peak'], lastFeaturedAt: recent }),
      cand({ id: 'b', arcShape: ['hidden peak'], lastFeaturedAt: recent }),
    ]
    const pick = pickDailyHero(candidates, wed)
    expect(pick?.usedFallback).toBe(true)
    expect(['a', 'b']).toContain(pick?.film.id)
  })

  it('nosedive tier 1: picks from the floored pool, no fallback', () => {
    const thu = nowForDow(4) // nosedive day
    const candidates = [
      cand({ id: 'tall', arcShape: ['nosedive'], peakScore: 8.2 }),
      cand({ id: 'short', arcShape: ['nosedive'], peakScore: 4.5 }),
      cand({ id: 'no-peak', arcShape: ['nosedive'], peakScore: null }),
    ]
    const pick = pickDailyHero(candidates, thu)
    expect(pick?.film.id).toBe('tall')
    expect(pick?.usedFallback).toBe(false)
  })

  it('nosedive floor boundary: peak exactly at the floor stays in tier 1', () => {
    const thu = nowForDow(4)
    const candidates = [
      cand({ id: 'edge', arcShape: ['nosedive'], peakScore: HERO_NOSEDIVE_MIN_PEAK }),
      cand({ id: 'below', arcShape: ['nosedive'], peakScore: HERO_NOSEDIVE_MIN_PEAK - 0.1 }),
    ]
    const pick = pickDailyHero(candidates, thu)
    expect(pick?.film.id).toBe('edge')
    expect(pick?.usedFallback).toBe(false)
  })

  it('nosedive tier 2: floored pool fully guard-excluded falls back to unfloored, guard still applied', () => {
    const thu = nowForDow(4)
    const recent = new Date(thu.getTime() - 3 * DAY)
    const candidates = [
      // Floored pool is NON-empty but every member was featured recently.
      cand({ id: 'tall-recent', arcShape: ['nosedive'], peakScore: 8, lastFeaturedAt: recent }),
      // Unfloored, not recently featured: tier 2 winner.
      cand({ id: 'short-fresh', arcShape: ['nosedive'], peakScore: 5 }),
      // Unfloored but guard-excluded: must NOT be picked (guard applies in tier 2).
      cand({ id: 'short-recent', arcShape: ['nosedive'], peakScore: 5, lastFeaturedAt: recent }),
    ]
    const pick = pickDailyHero(candidates, thu)
    expect(pick?.film.id).toBe('short-fresh')
    expect(pick?.usedFallback).toBe(true)
  })

  it('nosedive tier 3: guard empties everything, repeats rather than shows nothing', () => {
    const thu = nowForDow(4)
    const recent = new Date(thu.getTime() - 3 * DAY)
    const candidates = [
      cand({ id: 'a', arcShape: ['nosedive'], peakScore: 8, lastFeaturedAt: recent }),
      cand({ id: 'b', arcShape: ['nosedive'], peakScore: 5, lastFeaturedAt: recent }),
    ]
    const pick = pickDailyHero(candidates, thu)
    expect(pick).not.toBeNull()
    expect(pick?.usedFallback).toBe(true)
    expect(['a', 'b']).toContain(pick?.film.id)
  })

  it('non-nosedive shape angles ignore the peak floor', () => {
    const candidates = [cand({ id: 'low-peak', arcShape: ['hidden peak'], peakScore: 4 })]
    const pick = pickDailyHero(candidates, wed)
    expect(pick?.film.id).toBe('low-peak')
    expect(pick?.usedFallback).toBe(false)
  })

  it("stamping today's pick does not change today's pick (no midnight race)", () => {
    const candidates = [
      cand({ id: 'a', arcShape: ['hidden peak'] }),
      cand({ id: 'b', arcShape: ['hidden peak'] }),
      cand({ id: 'c', arcShape: ['hidden peak'] }),
    ]
    const first = pickDailyHero(candidates, wed)
    expect(first).not.toBeNull()

    // Simulate the side-effect stamp of today's winner.
    const stamped = candidates.map((c) =>
      c.id === first!.film.id ? { ...c, lastFeaturedAt: wed } : c,
    )
    const second = pickDailyHero(stamped, wed)
    expect(second?.film.id).toBe(first!.film.id)
  })
})
