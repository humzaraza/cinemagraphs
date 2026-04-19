import { describe, it, expect } from 'vitest'
import {
  decideCronRegen,
  MATURE_DAYS,
  QUALITY_REVIEW_THRESHOLD,
  REGEN_INTERVAL_DAYS,
} from '@/lib/cron-skip-logic'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-04-19T12:00:00.000Z')

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * MS_PER_DAY)
}

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * MS_PER_DAY)
}

describe('decideCronRegen', () => {
  it('skips a pre-release film (releaseDate in future)', () => {
    const result = decideCronRegen({
      releaseDate: daysFromNow(14),
      qualityReviewCount: 0,
      lastRegenAt: null,
      now: NOW,
    })
    expect(result).toEqual({ skip: true, reason: 'skipped_prerelease' })
  })

  it('marks a fresh film (released 30 days ago) eligible regardless of review count or regen age', () => {
    const result = decideCronRegen({
      releaseDate: daysAgo(30),
      qualityReviewCount: 50,
      lastRegenAt: daysAgo(1),
      now: NOW,
    })
    expect(result).toEqual({ skip: false, reason: 'eligible_recent_release' })
  })

  it('skips a mature film with 20 reviews and a 5-day-old graph (mature_stable)', () => {
    const result = decideCronRegen({
      releaseDate: daysAgo(200),
      qualityReviewCount: 20,
      lastRegenAt: daysAgo(5),
      now: NOW,
    })
    expect(result).toEqual({ skip: true, reason: 'skipped_mature_stable' })
  })

  it('marks a mature film with 20 reviews and a 45-day-old graph eligible (stale)', () => {
    const result = decideCronRegen({
      releaseDate: daysAgo(200),
      qualityReviewCount: 20,
      lastRegenAt: daysAgo(45),
      now: NOW,
    })
    expect(result).toEqual({ skip: false, reason: 'eligible_stale_regen' })
  })

  it('marks a mature film with 10 reviews eligible (thin coverage)', () => {
    const result = decideCronRegen({
      releaseDate: daysAgo(200),
      qualityReviewCount: 10,
      lastRegenAt: daysAgo(5),
      now: NOW,
    })
    expect(result).toEqual({ skip: false, reason: 'eligible_thin_coverage' })
  })

  it('marks a mature film with no SentimentGraph eligible (no_graph)', () => {
    const result = decideCronRegen({
      releaseDate: daysAgo(400),
      qualityReviewCount: 50,
      lastRegenAt: null,
      now: NOW,
    })
    expect(result).toEqual({ skip: false, reason: 'eligible_no_graph' })
  })

  it('skips a mature film with exactly QUALITY_REVIEW_THRESHOLD reviews (inclusive threshold)', () => {
    const result = decideCronRegen({
      releaseDate: daysAgo(200),
      qualityReviewCount: QUALITY_REVIEW_THRESHOLD,
      lastRegenAt: daysAgo(5),
      now: NOW,
    })
    expect(result).toEqual({ skip: true, reason: 'skipped_mature_stable' })
  })

  it('marks a mature film with QUALITY_REVIEW_THRESHOLD - 1 reviews eligible (below threshold)', () => {
    const result = decideCronRegen({
      releaseDate: daysAgo(200),
      qualityReviewCount: QUALITY_REVIEW_THRESHOLD - 1,
      lastRegenAt: daysAgo(5),
      now: NOW,
    })
    expect(result).toEqual({ skip: false, reason: 'eligible_thin_coverage' })
  })

  it('marks a mature film regenerated exactly REGEN_INTERVAL_DAYS ago eligible', () => {
    const result = decideCronRegen({
      releaseDate: daysAgo(200),
      qualityReviewCount: 20,
      lastRegenAt: daysAgo(REGEN_INTERVAL_DAYS),
      now: NOW,
    })
    expect(result).toEqual({ skip: false, reason: 'eligible_stale_regen' })
  })

  it('skips a mature film regenerated REGEN_INTERVAL_DAYS - 1 days ago', () => {
    const result = decideCronRegen({
      releaseDate: daysAgo(200),
      qualityReviewCount: 20,
      lastRegenAt: daysAgo(REGEN_INTERVAL_DAYS - 1),
      now: NOW,
    })
    expect(result).toEqual({ skip: true, reason: 'skipped_mature_stable' })
  })

  it('treats a film released exactly MATURE_DAYS ago as mature (not fresh)', () => {
    const result = decideCronRegen({
      releaseDate: daysAgo(MATURE_DAYS),
      qualityReviewCount: 20,
      lastRegenAt: daysAgo(5),
      now: NOW,
    })
    expect(result).toEqual({ skip: true, reason: 'skipped_mature_stable' })
  })

  it('treats a null releaseDate with no graph as eligible (no_graph wins)', () => {
    const result = decideCronRegen({
      releaseDate: null,
      qualityReviewCount: 0,
      lastRegenAt: null,
      now: NOW,
    })
    expect(result).toEqual({ skip: false, reason: 'eligible_no_graph' })
  })
})
