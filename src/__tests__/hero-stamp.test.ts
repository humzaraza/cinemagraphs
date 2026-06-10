import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma with spyable sentimentGraph methods so stampHeroFeatured can be
// exercised without a real client or database.
const findUnique = vi.fn()
const update = vi.fn()
vi.mock('@/lib/prisma', () => ({
  prisma: { sentimentGraph: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}))

import { stampHeroFeatured, isSameHeroDay, secondsUntilHeroMidnight } from '@/lib/hero'

beforeEach(() => {
  findUnique.mockReset()
  update.mockReset()
})

describe('isSameHeroDay', () => {
  it('treats two instants on the same Toronto calendar date as the same day', () => {
    // 04:00 UTC and 23:00 UTC on Jun 10 are both Jun 10 in Toronto (UTC-4).
    expect(isSameHeroDay(new Date('2026-06-10T04:00:00Z'), new Date('2026-06-10T23:00:00Z'))).toBe(true)
  })

  it('respects the Toronto day boundary, not the UTC one', () => {
    // 02:00 UTC Jun 10 is still Jun 9 evening in Toronto.
    expect(isSameHeroDay(new Date('2026-06-10T02:00:00Z'), new Date('2026-06-10T12:00:00Z'))).toBe(false)
    // Same UTC date, different Toronto dates.
    expect(isSameHeroDay(new Date('2026-06-10T03:59:00Z'), new Date('2026-06-10T04:01:00Z'))).toBe(false)
  })
})

describe('stampHeroFeatured', () => {
  const when = new Date('2026-06-10T16:00:00Z') // midday Toronto

  it('writes when the film has never been featured', async () => {
    findUnique.mockResolvedValue({ lastFeaturedAt: null })
    expect(await stampHeroFeatured('f1', when)).toBe(true)
    expect(update).toHaveBeenCalledWith({ where: { filmId: 'f1' }, data: { lastFeaturedAt: when } })
  })

  it('writes when lastFeaturedAt is a previous Toronto day', async () => {
    findUnique.mockResolvedValue({ lastFeaturedAt: new Date('2026-06-09T16:00:00Z') })
    expect(await stampHeroFeatured('f1', when)).toBe(true)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('skips the write on a second same-day invocation', async () => {
    findUnique.mockResolvedValue({ lastFeaturedAt: null })
    expect(await stampHeroFeatured('f1', when)).toBe(true)
    // Simulate the first stamp having landed, then a later cache miss same day.
    findUnique.mockResolvedValue({ lastFeaturedAt: when })
    expect(await stampHeroFeatured('f1', new Date('2026-06-10T22:00:00Z'))).toBe(false)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('writes when the row is missing (defensive: update will surface the error)', async () => {
    findUnique.mockResolvedValue(null)
    expect(await stampHeroFeatured('f1', when)).toBe(true)
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('secondsUntilHeroMidnight', () => {
  it('computes seconds remaining to the next Toronto midnight', () => {
    // 16:00 UTC Jun 10 = 12:00 Toronto (UTC-4): 12h remain.
    expect(secondsUntilHeroMidnight(new Date('2026-06-10T16:00:00Z'))).toBe(12 * 3600)
    // 03:59:30 UTC Jun 11 = 23:59:30 Toronto Jun 10: 30s remain, floored to 60.
    expect(secondsUntilHeroMidnight(new Date('2026-06-11T03:59:30Z'))).toBe(60)
    // Exactly Toronto midnight: full day ahead.
    expect(secondsUntilHeroMidnight(new Date('2026-06-11T04:00:00Z'))).toBe(86_400)
  })
})
