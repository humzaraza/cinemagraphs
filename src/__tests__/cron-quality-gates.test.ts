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
})
