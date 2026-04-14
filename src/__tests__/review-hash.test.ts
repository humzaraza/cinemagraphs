import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { computeReviewHash } from '@/lib/review-fetcher'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('computeReviewHash', () => {
  it('returns sha256 of empty string for empty review list', () => {
    expect(computeReviewHash([])).toBe(sha(''))
  })

  it('produces a stable, sorted, joined-by-pipe hash', () => {
    const result = computeReviewHash([
      { contentHash: 'b' },
      { contentHash: 'a' },
      { contentHash: 'c' },
    ])
    expect(result).toBe(sha('a|b|c'))
  })

  it('is insensitive to fetch / insertion order', () => {
    const a = computeReviewHash([
      { contentHash: 'hash1' },
      { contentHash: 'hash2' },
      { contentHash: 'hash3' },
    ])
    const b = computeReviewHash([
      { contentHash: 'hash3' },
      { contentHash: 'hash1' },
      { contentHash: 'hash2' },
    ])
    expect(a).toBe(b)
  })

  it('changes when a review is added', () => {
    const before = computeReviewHash([{ contentHash: 'x' }, { contentHash: 'y' }])
    const after = computeReviewHash([
      { contentHash: 'x' },
      { contentHash: 'y' },
      { contentHash: 'z' },
    ])
    expect(before).not.toBe(after)
  })

  it('changes when a review is removed', () => {
    const before = computeReviewHash([
      { contentHash: 'x' },
      { contentHash: 'y' },
      { contentHash: 'z' },
    ])
    const after = computeReviewHash([{ contentHash: 'x' }, { contentHash: 'y' }])
    expect(before).not.toBe(after)
  })

  it('changes when a single review changes', () => {
    const before = computeReviewHash([{ contentHash: 'x' }, { contentHash: 'y' }])
    const after = computeReviewHash([{ contentHash: 'x' }, { contentHash: 'Y' }])
    expect(before).not.toBe(after)
  })

  it('excludes null and empty contentHashes from the result', () => {
    // A null + a real hash should produce the same result as just the real hash.
    const withNulls = computeReviewHash([
      { contentHash: null },
      { contentHash: 'real' },
      { contentHash: '' },
    ])
    const withoutNulls = computeReviewHash([{ contentHash: 'real' }])
    expect(withNulls).toBe(withoutNulls)
  })

  it('is deterministic across separate calls', () => {
    const reviews = [{ contentHash: 'a' }, { contentHash: 'b' }, { contentHash: 'c' }]
    const r1 = computeReviewHash(reviews)
    const r2 = computeReviewHash(reviews)
    expect(r1).toBe(r2)
  })
})
