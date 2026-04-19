import { describe, it, expect } from 'vitest'
import { formatReviewProse } from '@/lib/review-prose'

describe('formatReviewProse', () => {
  it('joins all four populated fields with double newlines', () => {
    const result = formatReviewProse({
      beginning: 'Strong opening sequence.',
      middle: 'The pacing held up.',
      ending: 'A satisfying climax.',
      otherThoughts: 'Score was excellent.',
    })
    expect(result).toBe(
      'Strong opening sequence.\n\nThe pacing held up.\n\nA satisfying climax.\n\nScore was excellent.'
    )
  })

  it('returns just the beginning when only beginning is populated', () => {
    const result = formatReviewProse({
      beginning: 'I loved every minute of this.',
      middle: null,
      ending: null,
      otherThoughts: null,
    })
    expect(result).toBe('I loved every minute of this.')
  })

  it('joins beginning and ending with double newlines when middle/other are null', () => {
    const result = formatReviewProse({
      beginning: 'Opening was riveting.',
      middle: null,
      ending: 'Ending stuck the landing.',
      otherThoughts: null,
    })
    expect(result).toBe('Opening was riveting.\n\nEnding stuck the landing.')
  })

  it('skips empty strings and whitespace-only fields', () => {
    const result = formatReviewProse({
      beginning: 'Real content here.',
      middle: '',
      ending: '   ',
      otherThoughts: 'More real content.',
    })
    expect(result).toBe('Real content here.\n\nMore real content.')
  })

  it('returns empty string when all fields are null or empty', () => {
    expect(
      formatReviewProse({
        beginning: null,
        middle: null,
        ending: null,
        otherThoughts: null,
      })
    ).toBe('')

    expect(
      formatReviewProse({
        beginning: '',
        middle: '',
        ending: '',
        otherThoughts: '',
      })
    ).toBe('')

    expect(formatReviewProse({})).toBe('')
  })
})
