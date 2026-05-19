import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  prisma: {
    film: { findUnique: vi.fn() },
    similarFilm: { findMany: vi.fn() },
    userReview: { findMany: vi.fn() },
  },
  apiLogger: { error: vi.fn() },
  getMobileOrServerSession: vi.fn(),
  cachedQuery: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({
  apiLogger: mocks.apiLogger,
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))
vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/cache', () => ({
  cachedQuery: mocks.cachedQuery,
  KEYS: { film: (id: string) => `film:${id}`, filmSimilar: (id: string) => `film:${id}:similar` },
  TTL: { FILM: 3600 },
}))

const FILM_ID = 'src-film'

const baseFilm = {
  id: FILM_ID,
  tmdbId: 100,
  title: 'Source Film',
  releaseDate: new Date('2010-07-16'),
  posterUrl: '/p.jpg',
  director: 'Christopher Nolan',
  sentimentGraph: { overallScore: 8.4 },
  filmBeats: null,
}

const SIMILAR_FETCH_RESULT = [
  {
    id: 'sim-1',
    title: 'Memento',
    year: 2000,
    posterUrl: '/m.jpg',
    director: 'Christopher Nolan',
    score: 7.9,
    similarityScore: 0.85,
    matchSignals: { keywords: 0.6, genres: 0.4, director: 1, era: 0.6, keywordsDegraded: false },
  },
  {
    id: 'sim-2',
    title: 'Tenet',
    year: 2020,
    posterUrl: '/t.jpg',
    director: 'Christopher Nolan',
    score: 7.1,
    similarityScore: 0.74,
    matchSignals: { keywords: 0.5, genres: 0.4, director: 1, era: 0.6, keywordsDegraded: false },
  },
]

function makeRequest(query: string = '') {
  return new Request(`http://localhost/api/films/${FILM_ID}${query}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  // cachedQuery delegates to the wrapped fetch function
  mocks.cachedQuery.mockImplementation(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn())
  mocks.prisma.film.findUnique.mockResolvedValue(baseFilm)
  mocks.prisma.similarFilm.findMany.mockResolvedValue([])
  mocks.prisma.userReview.findMany.mockResolvedValue([])
  mocks.getMobileOrServerSession.mockResolvedValue(null)
})

async function callGET(query = '') {
  const { GET } = await import('@/app/api/films/[id]/route')
  return GET(makeRequest(query), { params: Promise.resolve({ id: FILM_ID }) })
}

describe('GET /api/films/[id] — similar films enrichment', () => {
  it('returns the film with an empty similarFilms array when none exist', async () => {
    const res = await callGET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(FILM_ID)
    expect(body.similarFilms).toEqual([])
  })

  it('hydrates similar films and slices to default 8', async () => {
    const longList = Array.from({ length: 20 }, (_, i) => ({
      id: `sim-${i}`,
      similarFilmId: `sim-${i}`,
      similarityScore: 1 - i * 0.01,
      matchSignals: { keywords: 0.5, genres: 0.5, director: 0, era: 0.6, keywordsDegraded: false },
      similar: {
        id: `sim-${i}`,
        title: `Sim ${i}`,
        releaseDate: new Date('2010-07-16T12:00:00Z'),
        posterUrl: `/p${i}.jpg`,
        director: 'D',
        sentimentGraph: { overallScore: 8 },
      },
    }))
    mocks.prisma.similarFilm.findMany.mockResolvedValue(longList)
    const res = await callGET()
    const body = await res.json()
    expect(body.similarFilms).toHaveLength(8)
    expect(body.similarFilms[0].id).toBe('sim-0')
    expect(body.similarFilms[0].year).toBe(2010)
    expect(body.similarFilms[0].score).toBe(8)
  })

  it('honors ?similar=N up to the max of 20', async () => {
    const longList = Array.from({ length: 30 }, (_, i) => ({
      id: `sim-${i}`,
      similarFilmId: `sim-${i}`,
      similarityScore: 1 - i * 0.01,
      matchSignals: {},
      similar: {
        id: `sim-${i}`,
        title: `Sim ${i}`,
        releaseDate: null,
        posterUrl: null,
        director: null,
        sentimentGraph: null,
      },
    }))
    mocks.prisma.similarFilm.findMany.mockResolvedValue(longList)
    const res = await callGET('?similar=15')
    const body = await res.json()
    expect(body.similarFilms).toHaveLength(15)
    expect(body.similarFilms[0].score).toBeNull()
    expect(body.similarFilms[0].year).toBeNull()
  })

  it('caps ?similar above 20 at 20 and always fetches up to 20 from prisma', async () => {
    const longList = Array.from({ length: 20 }, (_, i) => ({
      id: `sim-${i}`,
      similarFilmId: `sim-${i}`,
      similarityScore: 1 - i * 0.01,
      matchSignals: {},
      similar: {
        id: `sim-${i}`,
        title: `Sim ${i}`,
        releaseDate: null,
        posterUrl: null,
        director: null,
        sentimentGraph: null,
      },
    }))
    mocks.prisma.similarFilm.findMany.mockResolvedValue(longList)
    const res = await callGET('?similar=99')
    const body = await res.json()
    expect(body.similarFilms).toHaveLength(20)
    const findManyArgs = mocks.prisma.similarFilm.findMany.mock.calls[0][0]
    expect(findManyArgs.take).toBe(20)
  })

  it('returns userHasReviewed=false for everyone when unauthenticated', async () => {
    mocks.prisma.similarFilm.findMany.mockResolvedValue([
      {
        id: 'r1',
        similarFilmId: 'sim-1',
        similarityScore: 0.8,
        matchSignals: {},
        similar: { id: 'sim-1', title: 'A', releaseDate: null, posterUrl: null, director: null, sentimentGraph: null },
      },
    ])
    const res = await callGET()
    const body = await res.json()
    expect(body.similarFilms[0].userHasReviewed).toBe(false)
    expect(mocks.prisma.userReview.findMany).not.toHaveBeenCalled()
  })

  it('marks userHasReviewed=true for films the user has reviewed', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } })
    mocks.prisma.similarFilm.findMany.mockResolvedValue([
      {
        id: 'a',
        similarFilmId: 'sim-1',
        similarityScore: 0.8,
        matchSignals: {},
        similar: { id: 'sim-1', title: 'A', releaseDate: null, posterUrl: null, director: null, sentimentGraph: null },
      },
      {
        id: 'b',
        similarFilmId: 'sim-2',
        similarityScore: 0.7,
        matchSignals: {},
        similar: { id: 'sim-2', title: 'B', releaseDate: null, posterUrl: null, director: null, sentimentGraph: null },
      },
    ])
    mocks.prisma.userReview.findMany.mockResolvedValue([{ filmId: 'sim-1' }])
    const res = await callGET()
    const body = await res.json()
    expect(body.similarFilms.find((f: { id: string }) => f.id === 'sim-1').userHasReviewed).toBe(true)
    expect(body.similarFilms.find((f: { id: string }) => f.id === 'sim-2').userHasReviewed).toBe(false)
  })

  it('omits matchSignals in production for non-admin users', async () => {
    const originalEnv = process.env.NODE_ENV
    // @ts-expect-error: NODE_ENV is read-only at the type level but settable at runtime
    process.env.NODE_ENV = 'production'
    try {
      mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } })
      mocks.prisma.similarFilm.findMany.mockResolvedValue(
        SIMILAR_FETCH_RESULT.map((s) => ({
          id: s.id,
          similarFilmId: s.id,
          similarityScore: s.similarityScore,
          matchSignals: s.matchSignals,
          similar: {
            id: s.id,
            title: s.title,
            releaseDate: new Date(`${s.year}-01-01`),
            posterUrl: s.posterUrl,
            director: s.director,
            sentimentGraph: { overallScore: s.score },
          },
        })),
      )
      const res = await callGET()
      const body = await res.json()
      expect(body.similarFilms[0].matchSignals).toBeUndefined()
    } finally {
      // @ts-expect-error: NODE_ENV is read-only at the type level but settable at runtime
      process.env.NODE_ENV = originalEnv
    }
  })

  it('exposes matchSignals to admins in production', async () => {
    const originalEnv = process.env.NODE_ENV
    // @ts-expect-error: NODE_ENV is read-only at the type level but settable at runtime
    process.env.NODE_ENV = 'production'
    try {
      mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN' } })
      mocks.prisma.similarFilm.findMany.mockResolvedValue([
        {
          id: 'r',
          similarFilmId: 'sim-1',
          similarityScore: 0.8,
          matchSignals: { keywords: 0.5 },
          similar: { id: 'sim-1', title: 'A', releaseDate: null, posterUrl: null, director: null, sentimentGraph: null },
        },
      ])
      const res = await callGET()
      const body = await res.json()
      expect(body.similarFilms[0].matchSignals).toEqual({ keywords: 0.5 })
    } finally {
      // @ts-expect-error: NODE_ENV is read-only at the type level but settable at runtime
      process.env.NODE_ENV = originalEnv
    }
  })

  it('returns 404 when the film does not exist', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(null)
    const res = await callGET()
    expect(res.status).toBe(404)
  })
})

describe('GET /api/films/[id]: top-level userHasReviewed', () => {
  it('returns userHasReviewed=false when the request is unauthenticated', async () => {
    const res = await callGET()
    const body = await res.json()
    expect(body.userHasReviewed).toBe(false)
    expect(mocks.prisma.userReview.findMany).not.toHaveBeenCalled()
  })

  it('returns userHasReviewed=true when the authenticated user has reviewed this film', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } })
    mocks.prisma.userReview.findMany.mockResolvedValue([{ filmId: FILM_ID }])
    const res = await callGET()
    const body = await res.json()
    expect(body.userHasReviewed).toBe(true)
    const findManyArgs = mocks.prisma.userReview.findMany.mock.calls[0][0]
    expect(findManyArgs.where.filmId.in).toContain(FILM_ID)
  })

  it('returns userHasReviewed=false when the authenticated user has not reviewed this film', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } })
    mocks.prisma.userReview.findMany.mockResolvedValue([])
    const res = await callGET()
    const body = await res.json()
    expect(body.userHasReviewed).toBe(false)
  })
})
