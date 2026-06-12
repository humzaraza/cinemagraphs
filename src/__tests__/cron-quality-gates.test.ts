import { describe, it, expect } from 'vitest'
import { checkCronQualityGates } from '@/lib/cron-quality-gates'

function makeMovie(overrides: Record<string, unknown> = {}) {
  return {
    vote_count: 100,
    popularity: 50,
    runtime: 120,
    poster_path: '/poster.jpg',
    overview: 'A great film about things.',
    genres: [{ id: 28, name: 'Action' }],
    ...overrides,
  }
}

describe('checkCronQualityGates', () => {
  it('passes a film meeting all thresholds', () => {
    const result = checkCronQualityGates(makeMovie())
    expect(result).toEqual({ pass: true })
  })

  it('skips a film with low vote_count', () => {
    const result = checkCronQualityGates(makeMovie({ vote_count: 10 }))
    expect(result).toEqual({ pass: false, reason: 'lowVotes' })
  })

  it('skips a film with low popularity', () => {
    const result = checkCronQualityGates(makeMovie({ popularity: 5 }))
    expect(result).toEqual({ pass: false, reason: 'lowPopularity' })
  })

  it('skips a documentary (genre id 99)', () => {
    const result = checkCronQualityGates(
      makeMovie({ genres: [{ id: 99, name: 'Documentary' }] })
    )
    expect(result).toEqual({ pass: false, reason: 'excludedGenre' })
  })

  it('skips a TV Movie (genre id 10770)', () => {
    const result = checkCronQualityGates(
      makeMovie({ genres: [{ id: 10770, name: 'TV Movie' }] })
    )
    expect(result).toEqual({ pass: false, reason: 'excludedGenre' })
  })

  it('skips a film with no poster', () => {
    const result = checkCronQualityGates(makeMovie({ poster_path: undefined }))
    expect(result).toEqual({ pass: false, reason: 'noPoster' })
  })

  it('skips a film with short runtime', () => {
    const result = checkCronQualityGates(makeMovie({ runtime: 45 }))
    expect(result).toEqual({ pass: false, reason: 'shortRuntime' })
  })

  it('skips a film with no overview', () => {
    const result = checkCronQualityGates(makeMovie({ overview: undefined }))
    expect(result).toEqual({ pass: false, reason: 'noOverview' })
  })

  it('passes a film at exact thresholds', () => {
    const result = checkCronQualityGates(
      makeMovie({ vote_count: 30, popularity: 15, runtime: 60 })
    )
    expect(result).toEqual({ pass: true })
  })

  it('passes a documentary when allowDocumentaries is set', () => {
    const result = checkCronQualityGates(
      makeMovie({ genres: [{ id: 99, name: 'Documentary' }] }),
      { allowDocumentaries: true }
    )
    expect(result).toEqual({ pass: true })
  })

  it('still skips a TV Movie when allowDocumentaries is set', () => {
    const result = checkCronQualityGates(
      makeMovie({ genres: [{ id: 10770, name: 'TV Movie' }] }),
      { allowDocumentaries: true }
    )
    expect(result).toEqual({ pass: false, reason: 'excludedGenre' })
  })

  it('still skips a documentary TV Movie when allowDocumentaries is set', () => {
    const result = checkCronQualityGates(
      makeMovie({
        genres: [
          { id: 99, name: 'Documentary' },
          { id: 10770, name: 'TV Movie' },
        ],
      }),
      { allowDocumentaries: true }
    )
    expect(result).toEqual({ pass: false, reason: 'excludedGenre' })
  })

  it('other gates still apply when allowDocumentaries is set', () => {
    const result = checkCronQualityGates(
      makeMovie({ genres: [{ id: 99, name: 'Documentary' }], vote_count: 10 }),
      { allowDocumentaries: true }
    )
    expect(result).toEqual({ pass: false, reason: 'lowVotes' })
  })

  it('passes a low-popularity film when skipPopularityCheck is set', () => {
    const result = checkCronQualityGates(makeMovie({ popularity: 5 }), {
      skipPopularityCheck: true,
    })
    expect(result).toEqual({ pass: true })
  })

  it('still skips a low-popularity film by default', () => {
    const result = checkCronQualityGates(makeMovie({ popularity: 5 }), {})
    expect(result).toEqual({ pass: false, reason: 'lowPopularity' })
  })

  // The exact option profile scripts/bulk-import-studios.ts passes: archival
  // pull, so documentaries are allowed and the trending-biased popularity
  // floor is skipped, while votes, runtime, poster, overview, and the TV
  // Movie exclusion all still apply.
  describe('bulk-import-studios profile', () => {
    const SCRIPT_OPTIONS = { allowDocumentaries: true, skipPopularityCheck: true }

    it('passes a low-popularity documentary', () => {
      const result = checkCronQualityGates(
        makeMovie({ popularity: 0.5, genres: [{ id: 99, name: 'Documentary' }] }),
        SCRIPT_OPTIONS
      )
      expect(result).toEqual({ pass: true })
    })

    it('still skips a TV Movie', () => {
      const result = checkCronQualityGates(
        makeMovie({ genres: [{ id: 10770, name: 'TV Movie' }] }),
        SCRIPT_OPTIONS
      )
      expect(result).toEqual({ pass: false, reason: 'excludedGenre' })
    })

    it('still enforces the vote floor', () => {
      const result = checkCronQualityGates(
        makeMovie({ popularity: 0.5, vote_count: 29 }),
        SCRIPT_OPTIONS
      )
      expect(result).toEqual({ pass: false, reason: 'lowVotes' })
    })

    it('still enforces runtime, poster, and overview', () => {
      expect(checkCronQualityGates(makeMovie({ runtime: 45 }), SCRIPT_OPTIONS)).toEqual({
        pass: false,
        reason: 'shortRuntime',
      })
      expect(checkCronQualityGates(makeMovie({ poster_path: undefined }), SCRIPT_OPTIONS)).toEqual({
        pass: false,
        reason: 'noPoster',
      })
      expect(checkCronQualityGates(makeMovie({ overview: undefined }), SCRIPT_OPTIONS)).toEqual({
        pass: false,
        reason: 'noOverview',
      })
    })
  })
})
