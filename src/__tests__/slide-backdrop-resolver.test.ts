import { describe, it, expect } from 'vitest'
import { resolvePerSlideBackdrop } from '@/lib/carousel/slide-backdrop-resolver'

describe('resolvePerSlideBackdrop', () => {
  it('null input returns null', () => {
    expect(resolvePerSlideBackdrop(null, 3)).toBeNull()
  })

  it('undefined input returns null', () => {
    expect(resolvePerSlideBackdrop(undefined, 3)).toBeNull()
  })

  it('string input returns null (non-object JsonValue)', () => {
    expect(resolvePerSlideBackdrop('https://example.com/a.jpg', 3)).toBeNull()
  })

  it('number input returns null', () => {
    expect(resolvePerSlideBackdrop(42, 3)).toBeNull()
  })

  it('array input returns null', () => {
    expect(resolvePerSlideBackdrop(['https://a.jpg', 'https://b.jpg'], 1)).toBeNull()
  })

  it('object without matching key returns null', () => {
    expect(resolvePerSlideBackdrop({ '2': 'https://two.jpg' }, 3)).toBeNull()
  })

  it('object with matching key but non-string value returns null', () => {
    expect(resolvePerSlideBackdrop({ '1': 42 }, 1)).toBeNull()
    expect(resolvePerSlideBackdrop({ '1': null }, 1)).toBeNull()
  })

  it('object with matching key and string value returns the URL', () => {
    expect(resolvePerSlideBackdrop({ '3': 'https://three.jpg' }, 3)).toBe('https://three.jpg')
  })

  it('keys are looked up by stringified slideNumber', () => {
    const stringKeyed = { '1': 'https://one.jpg' }
    expect(resolvePerSlideBackdrop(stringKeyed, 1)).toBe('https://one.jpg')
  })

  it('works across all slide numbers 1-8', () => {
    const labels = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
    const json: Record<string, string> = {}
    labels.forEach((label, i) => {
      json[String(i + 1)] = `https://${label}.jpg`
    })
    for (let n = 1; n <= 8; n++) {
      expect(resolvePerSlideBackdrop(json, n)).toBe(`https://${labels[n - 1]}.jpg`)
    }
  })
})
