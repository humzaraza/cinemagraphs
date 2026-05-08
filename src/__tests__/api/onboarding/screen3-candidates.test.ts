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

  describe('multi-era stratification (2+ eras)', () => {
    it('round-robin merges 2 eras: positions 0 and 1 come from different eras', async () => {
      // Era 1 (era_2010s) returns ids film_1..film_12; Era 2 (era_2020s)
      // returns ids film_101..film_112. Promise.all preserves array order
      // so the first findMany call corresponds to selectedEras[0].
      mocks.prisma.film.findMany
        .mockResolvedValueOnce(makeFilms(12, 1)) // era_2010s
        .mockResolvedValueOnce(makeFilms(12, 101)) // era_2020s
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(postRequest({ eras: ['era_2010s', 'era_2020s'], genres: ['genre_thriller'] }))
      const body = await res.json()
      expect(body.fallback).toBe('exact')
      expect(body.films).toHaveLength(12)
      expect(body.films[0].id).toBe('film_1')
      expect(body.films[1].id).toBe('film_101')
      // Round-robin pattern: era1, era2, era1, era2, ...
      expect(body.films[2].id).toBe('film_2')
      expect(body.films[3].id).toBe('film_102')

      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(2)
    })

    it('round-robin with 3 eras: positions 0, 1, 2 come from different eras', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce(makeFilms(12, 1)) // era_2000s
        .mockResolvedValueOnce(makeFilms(12, 101)) // era_2010s
        .mockResolvedValueOnce(makeFilms(12, 201)) // era_2020s
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(
        postRequest({ eras: ['era_2000s', 'era_2010s', 'era_2020s'], genres: ['genre_action'] })
      )
      const body = await res.json()
      expect(body.fallback).toBe('exact')
      expect(body.films).toHaveLength(12)
      expect(body.films[0].id).toBe('film_1')
      expect(body.films[1].id).toBe('film_101')
      expect(body.films[2].id).toBe('film_201')
      expect(body.films[3].id).toBe('film_2')
    })

    it('issues one parallel query per era, each scoped to that era only', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce(makeFilms(12, 1))
        .mockResolvedValueOnce(makeFilms(12, 101))
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      await POST(postRequest({ eras: ['era_2010s', 'era_2020s'], genres: ['genre_thriller'] }))

      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(2)

      const era1Args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(era1Args.where.AND).toEqual([
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
        { genres: { hasSome: ['Thriller'] } },
      ])
      expect(era1Args.take).toBe(12)

      const era2Args = mocks.prisma.film.findMany.mock.calls[1][0]
      expect(era2Args.where.AND).toEqual([
        {
          OR: [
            {
              releaseDate: {
                gte: new Date('2020-01-01T00:00:00.000Z'),
                lt: new Date('2030-01-01T00:00:00.000Z'),
              },
            },
          ],
        },
        { genres: { hasSome: ['Thriller'] } },
      ])
      expect(era2Args.take).toBe(12)
    })

    it('sparse era contributes everything it has, dense era fills the rest', async () => {
      // Era 1 (1920s thrillers) is sparse (2 films); era 2 (2020s) is dense.
      mocks.prisma.film.findMany
        .mockResolvedValueOnce(makeFilms(2, 1)) // sparse era
        .mockResolvedValueOnce(makeFilms(12, 101)) // dense era
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(
        postRequest({ eras: ['era_1920s_30s', 'era_2020s'], genres: ['genre_thriller'] })
      )
      const body = await res.json()
      expect(body.fallback).toBe('exact')
      expect(body.films).toHaveLength(12)

      // Both sparse-era films should be present.
      const ids = body.films.map((f: { id: string }) => f.id)
      expect(ids).toContain('film_1')
      expect(ids).toContain('film_2')
      // 10 dense-era films fill the gap.
      const denseCount = ids.filter((id: string) => id.startsWith('film_1') && id !== 'film_1').length
      expect(denseCount).toBe(10)

      // Round-robin order: positions 0 and 1 alternate eras until sparse runs out.
      expect(body.films[0].id).toBe('film_1') // sparse[0]
      expect(body.films[1].id).toBe('film_101') // dense[0]
      expect(body.films[2].id).toBe('film_2') // sparse[1]
      expect(body.films[3].id).toBe('film_102') // dense[1]
    })

    it('4 eras with strong genre filter: round-robin picks from each in turn', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce(makeFilms(3, 1)) // era_1990s
        .mockResolvedValueOnce(makeFilms(3, 101)) // era_2000s
        .mockResolvedValueOnce(makeFilms(3, 201)) // era_2010s
        .mockResolvedValueOnce(makeFilms(3, 301)) // era_2020s
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(
        postRequest({
          eras: ['era_1990s', 'era_2000s', 'era_2010s', 'era_2020s'],
          genres: ['genre_horror'],
        })
      )
      const body = await res.json()
      expect(body.fallback).toBe('exact')
      expect(body.films).toHaveLength(12)

      // Each era should contribute exactly 3 films.
      const ids = body.films.map((f: { id: string }) => f.id)
      const era1Count = ids.filter((id: string) => /^film_[1-9]$|^film_1[0-2]$/.test(id) && parseInt(id.split('_')[1]) < 100).length
      const era2Count = ids.filter((id: string) => {
        const n = parseInt(id.split('_')[1])
        return n >= 101 && n <= 112
      }).length
      const era3Count = ids.filter((id: string) => {
        const n = parseInt(id.split('_')[1])
        return n >= 201 && n <= 212
      }).length
      const era4Count = ids.filter((id: string) => {
        const n = parseInt(id.split('_')[1])
        return n >= 301 && n <= 312
      }).length
      expect(era1Count).toBe(3)
      expect(era2Count).toBe(3)
      expect(era3Count).toBe(3)
      expect(era4Count).toBe(3)

      // First 4 positions: one from each era, in selectedEras order.
      expect(body.films[0].id).toBe('film_1')
      expect(body.films[1].id).toBe('film_101')
      expect(body.films[2].id).toBe('film_201')
      expect(body.films[3].id).toBe('film_301')
    })

    it('falls through to adjacent fallback when round-robin returns <12, preserving stratified picks', async () => {
      // Both eras yield only 2 films each. Round-robin produces 4 films,
      // then adjacent fills the rest.
      mocks.prisma.film.findMany
        .mockResolvedValueOnce(makeFilms(2, 1)) // era_2010s
        .mockResolvedValueOnce(makeFilms(2, 101)) // era_2020s
        .mockResolvedValueOnce(makeFilms(12, 500)) // adjacent fallback
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(
        postRequest({ eras: ['era_2010s', 'era_2020s'], genres: ['genre_horror'] })
      )
      const body = await res.json()
      expect(body.fallback).toBe('adjacent')
      expect(body.films).toHaveLength(12)

      // Round-robin picks survive at the front.
      expect(body.films[0].id).toBe('film_1')
      expect(body.films[1].id).toBe('film_101')
      expect(body.films[2].id).toBe('film_2')
      expect(body.films[3].id).toBe('film_102')
      // Adjacent appends 8 films from the fallback.
      expect(body.films[4].id).toBe('film_500')
      expect(body.films[11].id).toBe('film_507')

      // Adjacent query should include excluded ids (the 4 round-robin picks).
      const adjacentArgs = mocks.prisma.film.findMany.mock.calls[2][0]
      expect(adjacentArgs.where.id).toMatchObject({ notIn: expect.any(Array) })
      const excluded = adjacentArgs.where.id.notIn as string[]
      expect(excluded).toEqual(expect.arrayContaining(['film_1', 'film_2', 'film_101', 'film_102']))
      expect(excluded).toHaveLength(4)
    })

    it('cascades through to top-global when prior fallback stages run dry', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce(makeFilms(1, 1)) // era_1920s
        .mockResolvedValueOnce(makeFilms(1, 101)) // era_2020s
        .mockResolvedValueOnce(makeFilms(0)) // adjacent: 0 new
        .mockResolvedValueOnce(makeFilms(0)) // drop-genre: 0 new
        .mockResolvedValueOnce(makeFilms(12, 800)) // top-global
      const { POST } = await import('@/app/api/onboarding/screen3-candidates/route')

      const res = await POST(
        postRequest({ eras: ['era_1920s_30s', 'era_2020s'], genres: ['genre_horror'] })
      )
      const body = await res.json()
      expect(body.fallback).toBe('top-global')
      expect(body.films).toHaveLength(12)
      expect(body.films[0].id).toBe('film_1')
      expect(body.films[1].id).toBe('film_101')
      // top-global appends 10 unique films.
      expect(body.films[2].id).toBe('film_800')

      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(5)
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
