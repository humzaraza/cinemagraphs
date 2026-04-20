import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Fixtures ────────────────────────────────────────────────────────────────
// Dual-label fixture mirrors the ~1,227 films regenerated with both short
// `label` and longer `labelFull`. Legacy fixture mirrors the ~112 films that
// still only have `label` and must not break any serialization path.

const dualLabelDataPoints = [
  {
    timeStart: 0,
    timeEnd: 600,
    timeMidpoint: 300,
    score: 7.5,
    label: 'Opening',
    labelFull: 'Opening sequence establishes tone',
    confidence: 'high',
    reviewEvidence: 'Critics praised the cold open.',
  },
  {
    timeStart: 600,
    timeEnd: 1200,
    timeMidpoint: 900,
    score: 8.2,
    label: 'Reveal',
    labelFull: 'Mid-film twist reframes the protagonist',
    confidence: 'high',
    reviewEvidence: 'Reviews called it shocking.',
  },
]

const legacyDataPoints = [
  {
    timeStart: 0,
    timeEnd: 600,
    timeMidpoint: 300,
    score: 7.0,
    label: 'Opening',
    confidence: 'medium',
    reviewEvidence: 'Solid opening.',
  },
]

const dualLabelPeakMoment = {
  label: 'Climax',
  labelFull: 'Third-act confrontation lands',
  score: 9.1,
  time: 5400,
}

const dualLabelLowestMoment = {
  label: 'Sag',
  labelFull: 'Second-act pacing falters',
  score: 5.2,
  time: 3600,
}

const legacyPeakMoment = { label: 'Climax', score: 9.1, time: 5400 }
const legacyLowestMoment = { label: 'Sag', score: 5.2, time: 3600 }

function makeDualLabelGraph() {
  return {
    filmId: 'film-dual',
    overallScore: 7.8,
    previousScore: 7.6,
    anchoredFrom: 'TMDB',
    dataPoints: dualLabelDataPoints,
    peakMoment: dualLabelPeakMoment,
    lowestMoment: dualLabelLowestMoment,
    biggestSwing: 'Dual-label swing',
    summary: 'Summary for dual.',
    sourcesUsed: ['TMDB'],
    reviewCount: 42,
    generatedAt: new Date('2026-04-19T00:00:00Z'),
    varianceSource: 'external_only',
  }
}

function makeLegacyGraph() {
  return {
    filmId: 'film-legacy',
    overallScore: 7.0,
    previousScore: 7.0,
    anchoredFrom: 'TMDB',
    dataPoints: legacyDataPoints,
    peakMoment: legacyPeakMoment,
    lowestMoment: legacyLowestMoment,
    biggestSwing: 'Legacy swing',
    summary: 'Summary for legacy.',
    sourcesUsed: ['TMDB'],
    reviewCount: 15,
    generatedAt: new Date('2026-04-19T00:00:00Z'),
    varianceSource: 'external_only',
  }
}

function makeFilm(
  id: string,
  sentimentGraph: ReturnType<typeof makeDualLabelGraph> | ReturnType<typeof makeLegacyGraph>
) {
  return {
    id,
    title: `Film ${id}`,
    status: 'ACTIVE',
    posterUrl: null,
    backdropUrl: null,
    releaseDate: null,
    director: null,
    runtime: 120,
    genres: [],
    synopsis: null,
    tmdbId: 1,
    sentimentGraph,
    filmBeats: null,
  }
}

// ── Prisma mocks ────────────────────────────────────────────────────────────
const mockFilmFindUnique = vi.fn()
const mockFilmFindMany = vi.fn()
const mockFilmCount = vi.fn()
const mockGraphFindUnique = vi.fn()
const mockUserFindUnique = vi.fn()
const mockFollowCount = vi.fn()
const mockWatchlistFindMany = vi.fn()
const mockListFindMany = vi.fn()
const mockReviewFindMany = vi.fn()
const mockGetSession = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    film: {
      findUnique: (...args: unknown[]) => mockFilmFindUnique(...args),
      findMany: (...args: unknown[]) => mockFilmFindMany(...args),
      count: (...args: unknown[]) => mockFilmCount(...args),
    },
    sentimentGraph: {
      findUnique: (...args: unknown[]) => mockGraphFindUnique(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    follow: {
      count: (...args: unknown[]) => mockFollowCount(...args),
    },
    watchlist: {
      findMany: (...args: unknown[]) => mockWatchlistFindMany(...args),
    },
    list: {
      findMany: (...args: unknown[]) => mockListFindMany(...args),
    },
    userReview: {
      findMany: (...args: unknown[]) => mockReviewFindMany(...args),
    },
  },
}))

vi.mock('@/lib/cache', () => ({
  cachedQuery: async <T>(_key: string, _ttl: number, fetchFn: () => Promise<T>) => fetchFn(),
  KEYS: {
    film: (id: string) => `film:${id}`,
    graph: (id: string) => `graph:${id}`,
    homepage: (k: string) => `homepage:${k}`,
  },
  TTL: { FILM: 60, GRAPH: 60 },
}))

vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/lib/mobile-auth', () => ({
  getMobileOrServerSession: (...args: unknown[]) => mockGetSession(...args),
}))

import { GET as filmGet } from '@/app/api/films/[id]/route'
import { GET as graphGet } from '@/app/api/films/[id]/graph/route'
import { GET as filmsListGet } from '@/app/api/films/route'
import { GET as userFilmsGet } from '@/app/api/user/films/route'
import { GET as userGet } from '@/app/api/users/[id]/route'
import { NextRequest } from 'next/server'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('labelFull serialization across SentimentGraph API routes', () => {
  describe('GET /api/films/[id] (JSON passthrough include)', () => {
    it('preserves labelFull on dataPoints, peakMoment, and lowestMoment for dual-label films', async () => {
      mockFilmFindUnique.mockResolvedValue(makeFilm('film-dual', makeDualLabelGraph()))
      const res = await filmGet(new Request('http://localhost/api/films/film-dual'), {
        params: Promise.resolve({ id: 'film-dual' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sentimentGraph.dataPoints[0].label).toBe('Opening')
      expect(body.sentimentGraph.dataPoints[0].labelFull).toBe('Opening sequence establishes tone')
      expect(body.sentimentGraph.dataPoints[1].labelFull).toBe(
        'Mid-film twist reframes the protagonist'
      )
      expect(body.sentimentGraph.peakMoment.label).toBe('Climax')
      expect(body.sentimentGraph.peakMoment.labelFull).toBe('Third-act confrontation lands')
      expect(body.sentimentGraph.lowestMoment.label).toBe('Sag')
      expect(body.sentimentGraph.lowestMoment.labelFull).toBe('Second-act pacing falters')
    })

    it('returns 200 without throwing when labelFull is absent on legacy films', async () => {
      mockFilmFindUnique.mockResolvedValue(makeFilm('film-legacy', makeLegacyGraph()))
      const res = await filmGet(new Request('http://localhost/api/films/film-legacy'), {
        params: Promise.resolve({ id: 'film-legacy' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sentimentGraph.dataPoints[0].label).toBe('Opening')
      expect(body.sentimentGraph.dataPoints[0].labelFull).toBeUndefined()
      expect(body.sentimentGraph.peakMoment.labelFull).toBeUndefined()
      expect(body.sentimentGraph.lowestMoment.labelFull).toBeUndefined()
    })
  })

  describe('GET /api/films/[id]/graph (direct graph fetch)', () => {
    it('preserves labelFull throughout the graph payload', async () => {
      mockGraphFindUnique.mockResolvedValue(makeDualLabelGraph())
      const res = await graphGet(new Request('http://localhost/api/films/film-dual/graph'), {
        params: Promise.resolve({ id: 'film-dual' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.graph.dataPoints[0].labelFull).toBe('Opening sequence establishes tone')
      expect(body.graph.peakMoment.labelFull).toBe('Third-act confrontation lands')
      expect(body.graph.lowestMoment.labelFull).toBe('Second-act pacing falters')
    })

    it('serializes legacy graphs without labelFull without throwing', async () => {
      mockGraphFindUnique.mockResolvedValue(makeLegacyGraph())
      const res = await graphGet(new Request('http://localhost/api/films/film-legacy/graph'), {
        params: Promise.resolve({ id: 'film-legacy' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.graph.dataPoints[0].label).toBe('Opening')
      expect(body.graph.dataPoints[0].labelFull).toBeUndefined()
      expect(body.graph.peakMoment.labelFull).toBeUndefined()
      expect(body.graph.lowestMoment.labelFull).toBeUndefined()
    })
  })

  describe('GET /api/films (list with sparkline dataPoints)', () => {
    it('preserves labelFull on each listed film dataPoints', async () => {
      const films = [makeFilm('film-dual', makeDualLabelGraph())]
      mockFilmFindMany.mockResolvedValue(films)
      mockFilmCount.mockResolvedValue(films.length)
      const req = new NextRequest('http://localhost/api/films?page=1&limit=24')
      const res = await filmsListGet(req)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.films[0].sentimentGraph.dataPoints[0].labelFull).toBe(
        'Opening sequence establishes tone'
      )
    })

    it('serializes a legacy film in the list without labelFull', async () => {
      const films = [makeFilm('film-legacy', makeLegacyGraph())]
      mockFilmFindMany.mockResolvedValue(films)
      mockFilmCount.mockResolvedValue(films.length)
      const req = new NextRequest('http://localhost/api/films?page=1&limit=24')
      const res = await filmsListGet(req)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.films[0].sentimentGraph.dataPoints[0].label).toBe('Opening')
      expect(body.films[0].sentimentGraph.dataPoints[0].labelFull).toBeUndefined()
    })
  })

  describe('GET /api/user/films?type=reviewed (sparkline passthrough)', () => {
    it('preserves labelFull on the sparkline dataPoints blob', async () => {
      mockGetSession.mockResolvedValue({ user: { id: 'u1' } })
      mockReviewFindMany.mockResolvedValue([
        {
          overallRating: 8,
          createdAt: new Date('2026-04-19'),
          film: {
            id: 'film-dual',
            title: 'Dual',
            posterUrl: null,
            releaseDate: null,
            genres: [],
            sentimentGraph: { dataPoints: dualLabelDataPoints },
          },
        },
      ])
      const req = new NextRequest('http://localhost/api/user/films?type=reviewed')
      const res = await userFilmsGet(req)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.films[0].sparkline[0].labelFull).toBe('Opening sequence establishes tone')
    })

    it('returns 200 with an undefined labelFull when the underlying film is legacy', async () => {
      mockGetSession.mockResolvedValue({ user: { id: 'u1' } })
      mockReviewFindMany.mockResolvedValue([
        {
          overallRating: 7,
          createdAt: new Date('2026-04-19'),
          film: {
            id: 'film-legacy',
            title: 'Legacy',
            posterUrl: null,
            releaseDate: null,
            genres: [],
            sentimentGraph: { dataPoints: legacyDataPoints },
          },
        },
      ])
      const req = new NextRequest('http://localhost/api/user/films?type=reviewed')
      const res = await userFilmsGet(req)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.films[0].sparkline[0].label).toBe('Opening')
      expect(body.films[0].sparkline[0].labelFull).toBeUndefined()
    })
  })

  describe('GET /api/users/[id] (profile with review + watchlist sparklines)', () => {
    it('preserves labelFull on dataPoints in reviews and watchlist', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'u1',
        name: 'Alice',
        username: 'alice',
        image: null,
        bio: null,
        createdAt: new Date('2026-04-19'),
        isPublic: true,
        userReviews: [
          {
            overallRating: 8,
            beatRatings: null,
            createdAt: new Date('2026-04-19'),
            film: {
              id: 'film-dual',
              title: 'Dual',
              posterUrl: null,
              releaseDate: null,
              director: null,
              runtime: 120,
              sentimentGraph: { overallScore: 7.8, dataPoints: dualLabelDataPoints },
            },
          },
        ],
        liveReactions: [],
      })
      mockFollowCount.mockResolvedValue(0)
      mockWatchlistFindMany.mockResolvedValue([
        {
          createdAt: new Date('2026-04-19'),
          film: {
            id: 'film-dual',
            title: 'Dual',
            posterUrl: null,
            releaseDate: null,
            genres: [],
            runtime: 120,
            sentimentGraph: { overallScore: 7.8, dataPoints: dualLabelDataPoints },
          },
        },
      ])
      mockListFindMany.mockResolvedValue([])
      const req = new NextRequest('http://localhost/api/users/u1')
      const res = await userGet(req, { params: Promise.resolve({ id: 'u1' }) })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reviews[0].film.sentimentGraph.dataPoints[0].labelFull).toBe(
        'Opening sequence establishes tone'
      )
      expect(body.watchlist[0].sentimentGraph.dataPoints[0].labelFull).toBe(
        'Opening sequence establishes tone'
      )
    })

    it('returns 200 with undefined labelFull for legacy reviews', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'u2',
        name: 'Bob',
        username: 'bob',
        image: null,
        bio: null,
        createdAt: new Date('2026-04-19'),
        isPublic: true,
        userReviews: [
          {
            overallRating: 7,
            beatRatings: null,
            createdAt: new Date('2026-04-19'),
            film: {
              id: 'film-legacy',
              title: 'Legacy',
              posterUrl: null,
              releaseDate: null,
              director: null,
              runtime: 120,
              sentimentGraph: { overallScore: 7.0, dataPoints: legacyDataPoints },
            },
          },
        ],
        liveReactions: [],
      })
      mockFollowCount.mockResolvedValue(0)
      mockWatchlistFindMany.mockResolvedValue([])
      mockListFindMany.mockResolvedValue([])
      const req = new NextRequest('http://localhost/api/users/u2')
      const res = await userGet(req, { params: Promise.resolve({ id: 'u2' }) })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reviews[0].film.sentimentGraph.dataPoints[0].label).toBe('Opening')
      expect(body.reviews[0].film.sentimentGraph.dataPoints[0].labelFull).toBeUndefined()
    })
  })
})
