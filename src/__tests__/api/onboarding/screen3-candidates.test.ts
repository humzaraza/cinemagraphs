import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prisma: {
    film: { findMany: vi.fn() },
  },
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  loggerChild: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/redis', () => ({ redis: mocks.redis, REDIS_AVAILABLE: true }))
vi.mock('@/lib/logger', () => ({
  apiLogger: mocks.apiLogger,
  logger: { child: mocks.loggerChild },
}))

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/onboarding/screen3-candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeFilms(count: number, startId = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `film_${startId + i}`,
    tmdbId: 1000 + startId + i,
    title: `Film ${startId + i}`,
    releaseDate: new Date('2015-06-15T00:00:00.000Z'),
    posterUrl: `/poster_${startId + i}.jpg`,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.redis.get.mockResolvedValue(null)
  mocks.redis.set.mockResolvedValue('OK')
  mocks.prisma.film.findMany.mockResolvedValue([])
})

describe('POST /api/onboarding/screen3-candidates', () => {
  describe('exact-match path', () => {
    it('returns 12 films with fallback="exact" when era + genre intersection is dense', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: ['era_2010s'], genres: ['genre_scifi'] }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.fallback).toBe('exact')
      expect(body.films).toHaveLength(12)
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
    })

    it('builds the exact-match query with era yearRange (no expansion) and the selected genre tag', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      await POST(postRequest({ eras: ['era_2010s'], genres: ['genre_scifi'] }))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where.AND).toEqual([
        {
          OR: [
            {
              releaseDate: {
                gte: new Date('2010-01-01T00:00:00.000Z'),
                lt: new Date('2020-01-01T00:00:00.000Z'),
              },
            },
          ],
        },
        { genres: { hasSome: ['Science Fiction'] } },
      ])
    })

    it('maps the mobile "Sci-fi" label to the DB tag "Science Fiction"', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      await POST(postRequest({ eras: [], genres: ['genre_scifi'] }))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where.AND).toEqual([{ genres: { hasSome: ['Science Fiction'] } }])
    })
  })

  describe('adjacent-decade fallback', () => {
    it('expands each era by ±10 years when the exact pass returns <12', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce(makeFilms(5)) // exact
        .mockResolvedValueOnce(makeFilms(12, 100)) // adjacent
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: ['era_1980s'], genres: ['genre_horror'] }))
      const body = await res.json()
      expect(body.fallback).toBe('adjacent')
      expect(body.films).toHaveLength(12)

      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(2)
      const adjacentArgs = mocks.prisma.film.findMany.mock.calls[1][0]
      expect(adjacentArgs.where.AND).toEqual([
        {
          OR: [
            {
              releaseDate: {
                gte: new Date('1970-01-01T00:00:00.000Z'),
                lt: new Date('2000-01-01T00:00:00.000Z'),
              },
            },
          ],
        },
        { genres: { hasSome: ['Horror'] } },
      ])
    })
  })

  describe('genre-drop fallback', () => {
    it('drops the genre filter and keeps the expanded year range', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce(makeFilms(2)) // exact
        .mockResolvedValueOnce(makeFilms(5)) // adjacent
        .mockResolvedValueOnce(makeFilms(12, 200)) // genre-dropped
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: ['era_2020s'], genres: ['genre_horror'] }))
      const body = await res.json()
      expect(body.fallback).toBe('genre-dropped')
      expect(body.films).toHaveLength(12)

      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(3)
      const droppedArgs = mocks.prisma.film.findMany.mock.calls[2][0]
      expect(droppedArgs.where.AND).toEqual([
        {
          OR: [
            {
              releaseDate: {
                gte: new Date('2010-01-01T00:00:00.000Z'),
                lt: new Date('2040-01-01T00:00:00.000Z'),
              },
            },
          ],
        },
      ])
      expect(droppedArgs.where.AND[0].OR[0]).not.toHaveProperty('genres')
    })
  })

  describe('top-global fallback', () => {
    it('returns top-global when all earlier passes return <12', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce(makeFilms(0)) // exact
        .mockResolvedValueOnce(makeFilms(0)) // adjacent
        .mockResolvedValueOnce(makeFilms(3)) // genre-dropped
        .mockResolvedValueOnce(makeFilms(12, 300)) // top-global
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: ['era_1920s_30s'], genres: ['genre_thriller'] }))
      const body = await res.json()
      expect(body.fallback).toBe('top-global')
      expect(body.films).toHaveLength(12)

      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(4)
      const globalArgs = mocks.prisma.film.findMany.mock.calls[3][0]
      expect(globalArgs.where).not.toHaveProperty('AND')
    })

    it('both arrays empty short-circuits straight to top-global (single query)', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(8))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: [], genres: [] }))
      const body = await res.json()
      expect(body.fallback).toBe('top-global')
      expect(body.films).toHaveLength(8)
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where).not.toHaveProperty('AND')
    })

    it('treats omitted body fields as empty arrays', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(4))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({}))
      const body = await res.json()
      expect(body.fallback).toBe('top-global')
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
    })
  })

  describe('unknown ID handling', () => {
    it('silently drops unknown era IDs and falls through to top-global when all are unknown', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: ['era_NOT_REAL', 'era_also_fake'], genres: [] }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.fallback).toBe('top-global')
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
    })

    it('silently drops unknown genre IDs and uses only the recognized ones', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      await POST(postRequest({ eras: [], genres: ['genre_drama', 'genre_NOT_REAL'] }))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where.AND).toEqual([{ genres: { hasSome: ['Drama'] } }])
    })
  })

  describe('mosaic exclusion', () => {
    it('passes the 57 mosaic posterPaths to a notIn clause on posterUrl', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      await POST(postRequest({ eras: ['era_2010s'], genres: ['genre_scifi'] }))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where.posterUrl).toMatchObject({ notIn: expect.any(Array) })
      const exclusion = args.where.posterUrl.notIn as string[]
      expect(exclusion.length).toBe(57)
      // Each entry must be a TMDB-style relative path.
      expect(exclusion.every((p) => p.startsWith('/'))).toBe(true)
      // Must contain a known curated film.
      expect(exclusion).toContain('/yQvGrMoipbRoddT0ZR8tPoR7NfX.jpg') // Interstellar
    })

    it('always filters status=ACTIVE and releaseDate not null', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      await POST(postRequest({ eras: [], genres: [] }))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where.status).toBe('ACTIVE')
      expect(args.where.releaseDate).toEqual({ not: null })
    })
  })

  describe('sort order', () => {
    it('orders by imdbVotes desc nulls last with title asc tiebreaker', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      await POST(postRequest({ eras: ['era_2010s'], genres: ['genre_scifi'] }))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.orderBy).toEqual([
        { imdbVotes: { sort: 'desc', nulls: 'last' } },
        { title: 'asc' },
      ])
      expect(args.take).toBe(12)
    })

    it('shapes the response correctly: id, tmdbId, title, year (from releaseDate), posterPath (from posterUrl)', async () => {
      mocks.prisma.film.findMany.mockResolvedValue([
        {
          id: 'cuid_a',
          tmdbId: 27205,
          title: 'Inception',
          releaseDate: new Date('2010-07-16T00:00:00.000Z'),
          posterUrl: '/inception.jpg',
        },
      ])
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: [], genres: [] }))
      const body = await res.json()
      expect(body.films[0]).toEqual({
        id: 'cuid_a',
        tmdbId: 27205,
        title: 'Inception',
        year: 2010,
        posterPath: '/inception.jpg',
      })
    })
  })

  describe('cache', () => {
    it('cache hit returns the cached payload without querying the DB', async () => {
      const cached = {
        films: [
          { id: 'c1', tmdbId: 1, title: 'Cached', year: 2020, posterPath: '/c.jpg' },
        ],
        fallback: 'exact' as const,
      }
      mocks.redis.get.mockResolvedValue(cached)
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: ['era_2020s'], genres: ['genre_action'] }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(cached)
      expect(mocks.prisma.film.findMany).not.toHaveBeenCalled()
    })

    it('cache miss queries the DB and writes the result with TTL 86400', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      await POST(postRequest({ eras: ['era_2020s'], genres: ['genre_action'] }))
      // cacheSet is fire-and-forget; wait a tick.
      await new Promise((r) => setTimeout(r, 10))

      expect(mocks.redis.set).toHaveBeenCalledTimes(1)
      const [key, value, opts] = mocks.redis.set.mock.calls[0]
      expect(key).toBe('onboarding:screen3:era_2020s:genre_action')
      expect(opts).toEqual({ ex: 86400 })
      expect((value as { fallback: string }).fallback).toBe('exact')
    })

    it('different selection orders collapse to the same cache key', async () => {
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      await POST(postRequest({ eras: ['era_2020s', 'era_2010s'], genres: ['genre_thriller', 'genre_action'] }))
      await new Promise((r) => setTimeout(r, 10))

      const key = mocks.redis.set.mock.calls[0][0]
      // Sorted ascending by string compare.
      expect(key).toBe('onboarding:screen3:era_2010s,era_2020s:genre_action,genre_thriller')

      mocks.redis.set.mockClear()
      await POST(postRequest({ eras: ['era_2010s', 'era_2020s'], genres: ['genre_action', 'genre_thriller'] }))
      await new Promise((r) => setTimeout(r, 10))
      expect(mocks.redis.set.mock.calls[0][0]).toBe(key)
    })

    it('Redis unreachable on GET: query proceeds, no 500', async () => {
      mocks.redis.get.mockRejectedValue(new Error('ECONNREFUSED'))
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: ['era_2020s'], genres: [] }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.fallback).toBe('exact')
      expect(mocks.prisma.film.findMany).toHaveBeenCalled()
    })

    it('Redis unreachable on SET: response still succeeds', async () => {
      mocks.redis.set.mockRejectedValue(new Error('ECONNREFUSED'))
      mocks.prisma.film.findMany.mockResolvedValue(makeFilms(12))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: ['era_2020s'], genres: [] }))
      expect(res.status).toBe(200)
    })
  })

  describe('input validation', () => {
    it('400 when eras is not an array', async () => {
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')
      const res = await POST(postRequest({ eras: 'era_2020s', genres: [] }))
      expect(res.status).toBe(400)
    })

    it('400 when the body is malformed JSON', async () => {
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')
      const req = new NextRequest('http://localhost/api/onboarding/screen3-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      })
      const res = await POST(req)
      expect(res.status).toBe(400)
    })
  })
})
