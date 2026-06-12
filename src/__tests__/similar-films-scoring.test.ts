import { describe, it, expect } from 'vitest'
import {
  WEIGHTS,
  LANGUAGE_AFFINITY_BONUS,
  jaccard,
  cappedIntersection,
  directorScore,
  eraScore,
  scorePair,
  computeTopSimilarFor,
  type FilmForScoring,
} from '@/lib/similar-films'

function film(over: Partial<FilmForScoring>): FilmForScoring {
  return {
    id: over.id ?? 'x',
    keywords: over.keywords ?? [],
    genres: over.genres ?? [],
    director: over.director ?? null,
    releaseDate: over.releaseDate ?? null,
    originalLanguage: over.originalLanguage ?? null,
  }
}

describe('jaccard', () => {
  it('returns 0 when either side is empty', () => {
    expect(jaccard([], ['a', 'b'])).toBe(0)
    expect(jaccard(['a'], [])).toBe(0)
    expect(jaccard([], [])).toBe(0)
  })

  it('handles full overlap', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1)
  })

  it('handles partial overlap', () => {
    expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(2 / 4)
  })

  it('handles no overlap', () => {
    expect(jaccard(['a'], ['b'])).toBe(0)
  })

  it('treats arrays as sets (dedupes)', () => {
    expect(jaccard(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(1)
  })
})

describe('cappedIntersection', () => {
  it('returns 0 when either side is empty', () => {
    expect(cappedIntersection([], ['a', 'b'])).toBe(0)
    expect(cappedIntersection(['a'], [])).toBe(0)
    expect(cappedIntersection([], [])).toBe(0)
  })

  it('returns 0.0 when there is no overlap', () => {
    expect(cappedIntersection(['a', 'b'], ['c', 'd'])).toBe(0)
  })

  it('returns count/cap for shared elements below the cap', () => {
    expect(cappedIntersection(['a'], ['a', 'x', 'y'])).toBeCloseTo(0.2)
    expect(cappedIntersection(['a', 'b', 'c'], ['a', 'b', 'c', 'x'])).toBeCloseTo(0.6)
  })

  it('saturates at 1.0 when the intersection meets the cap exactly', () => {
    expect(cappedIntersection(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e'])).toBe(1)
  })

  it('clamps at 1.0 when more than `cap` elements are shared', () => {
    expect(
      cappedIntersection(
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      ),
    ).toBe(1)
  })

  it('honors a custom cap', () => {
    expect(cappedIntersection(['a', 'b', 'c'], ['a', 'b', 'c'], 3)).toBe(1)
    expect(cappedIntersection(['a'], ['a', 'b'], 2)).toBe(0.5)
  })

  it('treats arrays as sets (dedupes both sides)', () => {
    expect(cappedIntersection(['a', 'a', 'b'], ['a', 'b', 'b'])).toBeCloseTo(0.4)
  })
})

describe('directorScore', () => {
  it('returns 0 when either director is null', () => {
    expect(directorScore(null, 'Nolan')).toBe(0)
    expect(directorScore('Nolan', null)).toBe(0)
    expect(directorScore(null, null)).toBe(0)
  })

  it('returns 1 for exact match', () => {
    expect(directorScore('Nolan', 'Nolan')).toBe(1)
  })

  it('returns 0 for different directors', () => {
    expect(directorScore('Nolan', 'Tarantino')).toBe(0)
  })
})

describe('eraScore', () => {
  it('returns 0 when either year is null', () => {
    expect(eraScore(null, 2010)).toBe(0)
    expect(eraScore(2010, null)).toBe(0)
  })

  it('returns 1.0 for same decade', () => {
    expect(eraScore(2010, 2015)).toBe(1)
    expect(eraScore(2010, 2019)).toBe(1)
  })

  it('returns 0.6 for adjacent decades', () => {
    expect(eraScore(2010, 2020)).toBe(0.6)
    expect(eraScore(2000, 2019)).toBe(0.6)
  })

  it('returns 0.3 when within 30 years but not adjacent decade', () => {
    expect(eraScore(1990, 2020)).toBe(0.3) // exactly 30 years
    expect(eraScore(1980, 2010)).toBe(0.3) // exactly 30 years
  })

  it('returns 0 once year distance exceeds 30 (even when only 4 decades apart)', () => {
    expect(eraScore(1957, 2020)).toBe(0)
    expect(eraScore(1980, 2020)).toBe(0) // 40 years, beyond 30
    expect(eraScore(1979, 2020)).toBe(0)
  })

  it('treats the gap symmetrically', () => {
    expect(eraScore(1995, 2025)).toBe(eraScore(2025, 1995))
  })
})

describe('scorePair', () => {
  const inception = film({
    id: 'inception',
    keywords: ['dream', 'heist', 'sci-fi', 'mind-bending'],
    genres: ['Action', 'Science Fiction', 'Adventure'],
    director: 'Christopher Nolan',
    releaseDate: new Date('2010-07-16'),
  })

  it('applies full weights when both films have keywords', () => {
    const memento = film({
      id: 'memento',
      keywords: ['amnesia', 'mind-bending', 'nonlinear'],
      genres: ['Thriller', 'Mystery'],
      director: 'Christopher Nolan',
      releaseDate: new Date('2000-10-11'),
    })
    const r = scorePair(inception, memento)

    // Keyword signal uses cappedIntersection (cap=5), not Jaccard.
    const expectedKw = cappedIntersection(inception.keywords, memento.keywords, 5)
    const expectedGen = jaccard(inception.genres, memento.genres)
    const expectedEra = eraScore(2010, 2000)
    const expected =
      WEIGHTS.keywords * expectedKw +
      WEIGHTS.genres * expectedGen +
      WEIGHTS.director * 1 +
      WEIGHTS.era * expectedEra

    expect(r.signals.keywords).toBeCloseTo(expectedKw)
    expect(r.signals.director).toBe(1)
    expect(r.signals.era).toBe(0.6)
    expect(r.keywordsDegraded).toBe(false)
    expect(r.score).toBeCloseTo(expected)
  })

  it('zeros keyword contribution when source has no keywords (degraded, no renormalization)', () => {
    const sourceNoKw = { ...inception, keywords: [] }
    const candidate = film({
      id: 'c',
      keywords: ['heist'],
      genres: ['Action', 'Science Fiction', 'Adventure'],
      director: 'Christopher Nolan',
      releaseDate: new Date('2014-11-07'),
    })
    const r = scorePair(sourceNoKw, candidate)
    expect(r.keywordsDegraded).toBe(true)
    expect(r.signals.keywords).toBe(0)

    // No renormalization. All non-keyword signals at max → score is the literal
    // sum of non-keyword weights, which is the hard ceiling for any degraded
    // candidate.
    const expected = WEIGHTS.genres * 1 + WEIGHTS.director * 1 + WEIGHTS.era * 1
    expect(r.score).toBeCloseTo(expected)
    expect(r.score).toBeCloseTo(0.45)
  })

  it('caps degraded score at sum of non-keyword weights regardless of signals', () => {
    // Source has keywords, candidate does not. Candidate's other signals are
    // all maxed out, so this exercises the upper bound of the degraded path.
    const candidateNoKw = film({
      id: 'maxed',
      keywords: [],
      genres: ['Action', 'Science Fiction', 'Adventure'],
      director: 'Christopher Nolan',
      releaseDate: new Date('2010-01-01'),
    })
    const r = scorePair(inception, candidateNoKw)
    expect(r.keywordsDegraded).toBe(true)
    expect(r.signals.keywords).toBe(0)
    expect(r.score).toBeLessThanOrEqual(WEIGHTS.genres + WEIGHTS.director + WEIGHTS.era)
    expect(r.score).toBeLessThanOrEqual(0.45 + 1e-9)
  })

  it('flags degraded when candidate has no keywords (symmetric)', () => {
    const candidateNoKw = film({
      id: 'c',
      keywords: [],
      genres: ['Action'],
      director: 'Tarantino',
      releaseDate: new Date('2010-01-01'),
    })
    const r = scorePair(inception, candidateNoKw)
    expect(r.keywordsDegraded).toBe(true)
  })

  it('adds the language affinity bonus for a same-language non-English pair', () => {
    const a = film({
      id: 'a',
      keywords: ['poetic'],
      genres: ['Drama'],
      releaseDate: new Date('1997-01-01'),
      originalLanguage: 'fa',
    })
    const b = film({
      id: 'b',
      keywords: ['poetic'],
      genres: ['Drama'],
      releaseDate: new Date('1997-01-01'),
      originalLanguage: 'fa',
    })
    const r = scorePair(a, b)
    expect(r.languageAffinity).toBe(LANGUAGE_AFFINITY_BONUS)

    const weighted =
      WEIGHTS.keywords * cappedIntersection(a.keywords, b.keywords, 5) +
      WEIGHTS.genres * 1 +
      WEIGHTS.era * 1
    expect(r.score).toBeCloseTo(weighted + LANGUAGE_AFFINITY_BONUS)
  })

  it('gives no bonus to an en/en pair even when otherwise identical', () => {
    const a = film({ id: 'a', keywords: ['k'], genres: ['Drama'], originalLanguage: 'en' })
    const b = film({ id: 'b', keywords: ['k'], genres: ['Drama'], originalLanguage: 'en' })
    const r = scorePair(a, b)
    expect(r.languageAffinity).toBe(0)
  })

  it('gives no bonus across languages (en vs fa)', () => {
    const a = film({ id: 'a', keywords: ['k'], genres: ['Drama'], originalLanguage: 'en' })
    const b = film({ id: 'b', keywords: ['k'], genres: ['Drama'], originalLanguage: 'fa' })
    expect(scorePair(a, b).languageAffinity).toBe(0)
    expect(scorePair(b, a).languageAffinity).toBe(0)
  })

  it('gives no bonus when either language is null', () => {
    const fa = film({ id: 'a', keywords: ['k'], originalLanguage: 'fa' })
    const unknown = film({ id: 'b', keywords: ['k'], originalLanguage: null })
    expect(scorePair(fa, unknown).languageAffinity).toBe(0)
    expect(scorePair(unknown, fa).languageAffinity).toBe(0)
    expect(scorePair(unknown, { ...unknown, id: 'c' }).languageAffinity).toBe(0)
  })

  it('caps the final score at 1.0 when the bonus would exceed it', () => {
    const a = film({
      id: 'a',
      keywords: ['k1', 'k2', 'k3', 'k4', 'k5'],
      genres: ['Drama'],
      director: 'Kiarostami',
      releaseDate: new Date('1997-01-01'),
      originalLanguage: 'fa',
    })
    const b = { ...a, id: 'b' }
    const r = scorePair(a, b)
    // All four signals maxed: weighted sum is exactly 1.0; the bonus applies
    // but the cap holds.
    expect(r.languageAffinity).toBe(LANGUAGE_AFFINITY_BONUS)
    expect(r.score).toBe(1)
  })

  it('lets language affinity lift a degraded pair above the 0.45 ceiling (rescue case)', () => {
    const a = film({
      id: 'a',
      keywords: [],
      genres: ['Drama'],
      director: 'Same',
      releaseDate: new Date('1997-01-01'),
      originalLanguage: 'fa',
    })
    const b = { ...a, id: 'b' }
    const r = scorePair(a, b)
    expect(r.keywordsDegraded).toBe(true)
    expect(r.score).toBeCloseTo(0.45 + LANGUAGE_AFFINITY_BONUS)
  })

  it('returns 0 when nothing matches', () => {
    const candidate = film({
      id: 'unrelated',
      keywords: ['romance'],
      genres: ['Romance'],
      director: 'Nora Ephron',
      releaseDate: new Date('1990-01-01'),
    })
    const inceptionNoOverlap = film({
      id: 'inception',
      keywords: ['dream'],
      genres: ['Action'],
      director: 'Nolan',
      releaseDate: new Date('2070-01-01'),
    })
    const r = scorePair(inceptionNoOverlap, candidate)
    expect(r.score).toBe(0)
  })
})

describe('computeTopSimilarFor', () => {
  const source = film({
    id: 'source',
    keywords: ['heist', 'dream'],
    genres: ['Action'],
    director: 'Nolan',
    releaseDate: new Date('2010-01-01'),
  })

  it('excludes the source film itself', () => {
    const candidates: FilmForScoring[] = [
      source,
      film({ id: 'a', keywords: ['heist'], genres: ['Action'], director: 'Nolan', releaseDate: new Date('2012-01-01') }),
    ]
    const top = computeTopSimilarFor(source, candidates)
    expect(top.find((t) => t.filmId === 'source')).toBeUndefined()
    expect(top.map((t) => t.filmId)).toContain('a')
  })

  it('drops candidates with score 0', () => {
    const candidates: FilmForScoring[] = [
      film({ id: 'unrelated', keywords: ['romance'], genres: ['Romance'], director: 'X', releaseDate: new Date('2070-01-01') }),
      film({ id: 'good', keywords: ['heist'], genres: ['Action'], director: 'Nolan', releaseDate: new Date('2010-01-01') }),
    ]
    const top = computeTopSimilarFor(source, candidates)
    expect(top.map((t) => t.filmId)).toEqual(['good'])
  })

  it('sorts descending by score and caps to N', () => {
    const candidates: FilmForScoring[] = [
      film({ id: 'low', keywords: [], genres: ['Drama'], director: null, releaseDate: new Date('2010-01-01') }),
      film({ id: 'high', keywords: ['heist', 'dream'], genres: ['Action'], director: 'Nolan', releaseDate: new Date('2010-01-01') }),
      film({ id: 'mid', keywords: ['heist'], genres: ['Action'], director: 'Nolan', releaseDate: new Date('2010-01-01') }),
    ]
    const top = computeTopSimilarFor(source, candidates, 2)
    expect(top.map((t) => t.filmId)).toEqual(['high', 'mid'])
  })
})
