import { describe, it, expect } from 'vitest'
import {
  BODY_SOFT_LIMIT,
  HEADLINE_MAX,
  bodyExceedsSoftLimit,
  clampHeadline,
  headlineCounterState,
  slideCopyEqual,
} from '@/lib/carousel/body-copy-edit'

describe('clampHeadline', () => {
  it('passes through strings at or below the limit', () => {
    expect(clampHeadline('hello')).toBe('hello')
    expect(clampHeadline('a'.repeat(HEADLINE_MAX))).toHaveLength(HEADLINE_MAX)
  })

  it('truncates overlong input to the limit', () => {
    const input = 'a'.repeat(HEADLINE_MAX + 20)
    const out = clampHeadline(input)
    expect(out).toHaveLength(HEADLINE_MAX)
    expect(out).toBe('a'.repeat(HEADLINE_MAX))
  })

  it('accepts a custom max', () => {
    expect(clampHeadline('abcdef', 3)).toBe('abc')
  })

  it('handles empty string', () => {
    expect(clampHeadline('')).toBe('')
  })
})

describe('headlineCounterState', () => {
  it('is neutral below the warn threshold', () => {
    expect(headlineCounterState(0)).toBe('neutral')
    expect(headlineCounterState(69)).toBe('neutral')
  })

  it('is warn at or above 70 and below max', () => {
    expect(headlineCounterState(70)).toBe('warn')
    expect(headlineCounterState(79)).toBe('warn')
  })

  it('is danger at the hard cap', () => {
    expect(headlineCounterState(HEADLINE_MAX)).toBe('danger')
    expect(headlineCounterState(HEADLINE_MAX + 5)).toBe('danger')
  })
})

describe('bodyExceedsSoftLimit', () => {
  it('returns false at or below the default limit', () => {
    expect(bodyExceedsSoftLimit('')).toBe(false)
    expect(bodyExceedsSoftLimit('a'.repeat(BODY_SOFT_LIMIT))).toBe(false)
  })

  it('returns true above the default limit', () => {
    expect(bodyExceedsSoftLimit('a'.repeat(BODY_SOFT_LIMIT + 1))).toBe(true)
  })

  it('respects a custom limit', () => {
    expect(bodyExceedsSoftLimit('abcd', 3)).toBe(true)
    expect(bodyExceedsSoftLimit('abc', 3)).toBe(false)
  })
})

describe('slideCopyEqual', () => {
  const base = { pill: 'P', headline: 'H', body: 'B' }

  it('returns true for identical copy', () => {
    expect(slideCopyEqual(base, { ...base })).toBe(true)
  })

  it('returns false when any field differs', () => {
    expect(slideCopyEqual(base, { ...base, pill: 'X' })).toBe(false)
    expect(slideCopyEqual(base, { ...base, headline: 'X' })).toBe(false)
    expect(slideCopyEqual(base, { ...base, body: 'X' })).toBe(false)
  })

  it('is whitespace-sensitive on purpose', () => {
    expect(slideCopyEqual(base, { ...base, headline: 'H ' })).toBe(false)
  })
})
