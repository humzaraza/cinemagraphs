import { describe, it, expect, vi } from 'vitest'
import { attachUserHasReviewed } from '@/lib/user-review-flags'

// attachUserHasReviewed is pure, but the module also exports the prisma-backed
// getReviewedFilmIds; mock the client so importing the module never constructs
// a real one.
vi.mock('@/lib/prisma', () => ({ prisma: { userReview: { findMany: vi.fn() } } }))

describe('attachUserHasReviewed', () => {
  it('flags films whose id is in the reviewed set and leaves the rest false', () => {
    const films = [
      { id: 'f1', title: 'Reviewed' },
      { id: 'f2', title: 'Not reviewed' },
      { id: 'f3', title: 'Also reviewed' },
    ]
    const out = attachUserHasReviewed(films, new Set(['f1', 'f3']))
    expect(out).toEqual([
      { id: 'f1', title: 'Reviewed', userHasReviewed: true },
      { id: 'f2', title: 'Not reviewed', userHasReviewed: false },
      { id: 'f3', title: 'Also reviewed', userHasReviewed: true },
    ])
  })

  it('does not mutate the input array or the input objects', () => {
    const film = { id: 'f1', title: 'Original' }
    const films = [film]
    const out = attachUserHasReviewed(films, new Set(['f1']))

    // New array, new objects.
    expect(out).not.toBe(films)
    expect(out[0]).not.toBe(film)

    // Originals untouched: no flag added, contents identical.
    expect(films).toEqual([{ id: 'f1', title: 'Original' }])
    expect('userHasReviewed' in film).toBe(false)
  })

  it('returns an empty array for an empty input', () => {
    expect(attachUserHasReviewed([], new Set(['f1']))).toEqual([])
  })
})
