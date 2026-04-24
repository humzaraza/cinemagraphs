import { describe, it, expect } from 'vitest'
import {
  buildZipFilename,
  buildSlideFilename,
  slugify,
} from '@/lib/carousel/zip-export-naming'

// Using the zero-based-month Date constructor gives us local-time dates that
// are deterministic regardless of host timezone — `getMonth/getDate/getFullYear`
// read local fields, so new Date(2026, 3, 22) always yields April 22, 2026.
const APRIL_22_2026 = new Date(2026, 3, 22)

describe('slugify', () => {
  it('lowercases alphabetic words and joins with hyphens', () => {
    expect(slugify('Project Hail Mary')).toBe('project-hail-mary')
  })

  it('replaces punctuation with hyphens and collapses runs', () => {
    expect(slugify('Kill Bill: Vol. 1')).toBe('kill-bill-vol-1')
  })

  it('preserves numeric-leading titles', () => {
    expect(slugify('12 Angry Men')).toBe('12-angry-men')
  })

  it('collapses consecutive spaces into one hyphen', () => {
    expect(slugify('Two   Spaces')).toBe('two-spaces')
  })

  it('trims trailing punctuation into a clean tail', () => {
    expect(slugify('The Matrix!')).toBe('the-matrix')
  })

  it('trims leading punctuation', () => {
    expect(slugify('  Leading spaces')).toBe('leading-spaces')
  })

  it('caps slug length at 50 characters with no trailing hyphen', () => {
    const longTitle =
      'A Really Long Movie Title That Goes On And On And Will Need Truncation'
    const out = slugify(longTitle)
    expect(out.length).toBeLessThanOrEqual(50)
    expect(out.endsWith('-')).toBe(false)
    expect(out.startsWith('a-really-long-movie-title')).toBe(true)
  })
})

describe('buildZipFilename', () => {
  it('builds the Project Hail Mary example', () => {
    expect(
      buildZipFilename({
        filmTitle: 'Project Hail Mary',
        format: '4x5',
        now: APRIL_22_2026,
      }),
    ).toBe('cinemagraphs-project-hail-mary-4x5-20260422.zip')
  })

  it('builds the Kill Bill example', () => {
    expect(
      buildZipFilename({
        filmTitle: 'Kill Bill: Vol. 1',
        format: '9x16',
        now: APRIL_22_2026,
      }),
    ).toBe('cinemagraphs-kill-bill-vol-1-9x16-20260422.zip')
  })

  it('builds the numeric-leading example', () => {
    expect(
      buildZipFilename({
        filmTitle: '12 Angry Men',
        format: '4x5',
        now: APRIL_22_2026,
      }),
    ).toBe('cinemagraphs-12-angry-men-4x5-20260422.zip')
  })

  it('zero-pads single-digit month and day', () => {
    const jan3 = new Date(2026, 0, 3)
    expect(
      buildZipFilename({ filmTitle: 'X', format: '4x5', now: jan3 }),
    ).toBe('cinemagraphs-x-4x5-20260103.zip')
  })

  it('uses format string as-is (4x5 and 9x16 pass through)', () => {
    const outA = buildZipFilename({ filmTitle: 'T', format: '4x5', now: APRIL_22_2026 })
    const outB = buildZipFilename({ filmTitle: 'T', format: '9x16', now: APRIL_22_2026 })
    expect(outA).toContain('-4x5-')
    expect(outB).toContain('-9x16-')
  })
})

describe('buildSlideFilename', () => {
  it('zero-pads slide 1 to 01', () => {
    expect(buildSlideFilename({ slideNumber: 1, slotKind: 'hook' })).toBe(
      '01-hook.png',
    )
  })

  it('formats the drop slide', () => {
    expect(buildSlideFilename({ slideNumber: 4, slotKind: 'drop' })).toBe(
      '04-drop.png',
    )
  })

  it('formats the takeaway slide', () => {
    expect(buildSlideFilename({ slideNumber: 8, slotKind: 'takeaway' })).toBe(
      '08-takeaway.png',
    )
  })

  it('keeps 2-digit slide numbers without prefix padding', () => {
    expect(buildSlideFilename({ slideNumber: 10, slotKind: 'extra' })).toBe(
      '10-extra.png',
    )
  })

  it('hyphenates multi-word slot kinds', () => {
    expect(buildSlideFilename({ slideNumber: 5, slotKind: 'First Contact' })).toBe(
      '05-first-contact.png',
    )
  })
})
