import { describe, expect, it } from 'vitest'
import { averageUserReviewScore, userReviewScore } from '@/lib/user-review-score'

// The score shown on a user's own review: half the mean of the beats they
// rated, half their overall slider. Overall alone when no beats were rated.

describe('userReviewScore', () => {
  it('is the overall rating alone when no beats were rated', () => {
    expect(userReviewScore(7.5, null)).toBe(7.5)
    expect(userReviewScore(7.5, undefined)).toBe(7.5)
    expect(userReviewScore(7.5, {})).toBe(7.5)
  })

  it('blends 50/50 with the mean of the rated beats', () => {
    // beats 8, 7, 9 average 8.0; overall 6 -> 7.0
    expect(userReviewScore(6, { a: 8, b: 7, c: 9 })).toBe(7)
    // one beat 9, overall 5 -> 7.0
    expect(userReviewScore(5, { a: 9 })).toBe(7)
  })

  it('rounds to one decimal, half up', () => {
    // beat 7, overall 7.5 -> 7.25 -> 7.3
    expect(userReviewScore(7.5, { a: 7 })).toBe(7.3)
    // beats 6, 5.5 (mean 5.75), overall 8.5 -> 7.125 -> 7.1
    expect(userReviewScore(8.5, { a: 6, b: 5.5 })).toBe(7.1)
  })

  it('ignores non-numeric beat values rather than averaging around them', () => {
    expect(userReviewScore(6, { a: 8, b: 'x' as unknown as number, c: null as unknown as number })).toBe(7)
    expect(userReviewScore(6, { a: 'x' as unknown as number })).toBe(6)
  })
})

describe('averageUserReviewScore', () => {
  it('averages the per-review scores and rounds to one decimal', () => {
    const reviews = [
      { overallRating: 6, beatRatings: { a: 8, b: 7, c: 9 } }, // 7.0
      { overallRating: 8.5, beatRatings: null }, // 8.5
    ]
    expect(averageUserReviewScore(reviews)).toBe(7.8) // 7.75 -> 7.8
  })

  it('is null with no reviews', () => {
    expect(averageUserReviewScore([])).toBeNull()
  })
})
