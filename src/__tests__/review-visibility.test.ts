import { describe, it, expect, vi } from 'vitest'
import { canViewReview } from '@/lib/review-detail'

// canViewReview is pure, but its module also exports the prisma-backed
// getReviewById. Stub the client so importing the rule never constructs a
// real PrismaClient.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

const AUTHOR_ID = 'u-author'
const STRANGER_ID = 'u-stranger'

describe('canViewReview', () => {
  describe('approved reviews are public', () => {
    it('anonymous viewer can see an approved review', () => {
      expect(canViewReview('approved', AUTHOR_ID, null)).toBe(true)
    })

    it('signed-in stranger can see an approved review', () => {
      expect(canViewReview('approved', AUTHOR_ID, STRANGER_ID)).toBe(true)
    })

    it('author can see their own approved review', () => {
      expect(canViewReview('approved', AUTHOR_ID, AUTHOR_ID)).toBe(true)
    })
  })

  describe('flagged reviews resolve for the author only', () => {
    it('anonymous viewer cannot see a flagged review', () => {
      expect(canViewReview('flagged', AUTHOR_ID, null)).toBe(false)
    })

    it('signed-in stranger cannot see a flagged review', () => {
      expect(canViewReview('flagged', AUTHOR_ID, STRANGER_ID)).toBe(false)
    })

    it('author can see their own flagged review', () => {
      expect(canViewReview('flagged', AUTHOR_ID, AUTHOR_ID)).toBe(true)
    })
  })

  describe('rejected reviews resolve for the author only', () => {
    it('anonymous viewer cannot see a rejected review', () => {
      expect(canViewReview('rejected', AUTHOR_ID, null)).toBe(false)
    })

    it('author can see their own rejected review', () => {
      expect(canViewReview('rejected', AUTHOR_ID, AUTHOR_ID)).toBe(true)
    })
  })

  describe('the rule is approved-or-author, nothing else', () => {
    it('treats an unrecognized status as non-public', () => {
      // A status added later is hidden until the rule says otherwise.
      expect(canViewReview('quarantined', AUTHOR_ID, STRANGER_ID)).toBe(false)
      expect(canViewReview('quarantined', AUTHOR_ID, AUTHOR_ID)).toBe(true)
    })

    it('is case-sensitive on the approved status', () => {
      expect(canViewReview('Approved', AUTHOR_ID, STRANGER_ID)).toBe(false)
    })

    it('never matches an author on a null viewer, even for an empty author id', () => {
      // Guards the null check: `viewerId === authorId` alone would be true
      // if both sides were ever nullish.
      expect(canViewReview('flagged', '', null)).toBe(false)
    })

    it('never matches an empty-string viewer id to an empty-string author id', () => {
      // A `viewerId !== null` guard would pass this: '' === '' is true, so a
      // viewer whose id resolved to the empty string would own every hidden
      // review with an empty author id. The check is falsy for that reason.
      expect(canViewReview('flagged', '', '')).toBe(false)
      expect(canViewReview('rejected', '', '')).toBe(false)
    })
  })
})
