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
  pickBestBackdrop: vi.fn(),
  apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  loggerChild: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/redis', () => ({ redis: mocks.redis, REDIS_AVAILABLE: true }))
vi.mock('@/lib/backdrop-selector', () => ({
  pickBestBackdrop: mocks.pickBestBackdrop,
}))
vi.mock('@/lib/logger', () => ({
  apiLogger: mocks.apiLogger,
  logger: { child: mocks.loggerChild },
}))

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/onboarding/select-banner', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeFilm(id: string, tmdbId: number, title: string) {
  return { id, tmdbId, title }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.redis.get.mockResolvedValue(null)
  mocks.redis.set.mockResolvedValue('OK')
  mocks.prisma.film.findMany.mockResolvedValue([])
  mocks.pickBestBackdrop.mockResolvedValue(null)
})

describe('POST /api/onboarding/select-banner', () => {
  describe('step 1: screen3 picks', () => {
    it('returns BACKDROP/source=screen3 when the top-rated filmId has a backdrop', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([
        makeFilm('film_a', 100, 'A'),
        makeFilm('film_b', 200, 'B'),
        makeFilm('film_c', 300, 'C'),
      ])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/best.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: ['film_a', 'film_b', 'film_c'], genres: [], eras: [] })
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        bannerType: 'BACKDROP',
        bannerValue: { filmId: 'film_a', backdropPath: '/best.jpg' },
        source: 'screen3',
      })
      expect(mocks.pickBestBackdrop).toHaveBeenCalledTimes(1)
      expect(mocks.pickBestBackdrop).toHaveBeenCalledWith(100)
    })

    it('falls to the next film when the top-rated has no backdrop', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([
        makeFilm('film_a', 100, 'A'),
        makeFilm('film_b', 200, 'B'),
        makeFilm('film_c', 300, 'C'),
      ])
      mocks.pickBestBackdrop
        .mockResolvedValueOnce(null) // film_a: no quality backdrop
        .mockResolvedValueOnce('/second.jpg') // film_b: has one
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: ['film_a', 'film_b', 'film_c'], genres: [], eras: [] })
      )
      const body = await res.json()
      expect(body.source).toBe('screen3')
      expect(body.bannerValue).toEqual({ filmId: 'film_b', backdropPath: '/second.jpg' })
      expect(mocks.pickBestBackdrop).toHaveBeenCalledTimes(2)
    })

    it('falls through to step 2 (genres) when none of the screen3 films have backdrops', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce([
          makeFilm('film_a', 100, 'A'),
          makeFilm('film_b', 200, 'B'),
        ]) // step 1 query
        .mockResolvedValueOnce([
          makeFilm('film_genre', 700, 'GenreFilm'),
        ]) // step 2 query
      mocks.pickBestBackdrop
        .mockResolvedValueOnce(null) // film_a
        .mockResolvedValueOnce(null) // film_b
        .mockResolvedValueOnce('/genre.jpg') // film_genre
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: ['film_a', 'film_b'], genres: ['genre_thriller'], eras: [] })
      )
      const body = await res.json()
      expect(body.source).toBe('genre')
      expect(body.bannerValue).toEqual({ filmId: 'film_genre', backdropPath: '/genre.jpg' })
      expect(mocks.pickBestBackdrop).toHaveBeenCalledTimes(3)
    })

    it('queries the DB by id IN with status ACTIVE and the rating-first sort', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([makeFilm('film_a', 100, 'A')])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/x.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      await POST(postRequest({ filmIds: ['film_b', 'film_a'], genres: [], eras: [] }))

      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      // filmIds get deduped + sorted before query (and cache key).
      expect(args.where).toEqual({ id: { in: ['film_a', 'film_b'] }, status: 'ACTIVE' })
      expect(args.orderBy).toEqual([
        { imdbRating: { sort: 'desc', nulls: 'last' } },
        { imdbVotes: { sort: 'desc', nulls: 'last' } },
        { title: 'asc' },
      ])
    })
  })

  describe('step 2: genre cascade', () => {
    it('queries genre-block film posterPaths and returns BACKDROP/source=genre', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([
        makeFilm('film_genre', 700, 'GenreFilm'),
      ])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/genre.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(postRequest({ filmIds: [], genres: ['genre_thriller'], eras: [] }))
      const body = await res.json()
      expect(body).toEqual({
        bannerType: 'BACKDROP',
        bannerValue: { filmId: 'film_genre', backdropPath: '/genre.jpg' },
        source: 'genre',
      })

      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      // Posters from the thriller block of onboardingCuration.ts
      // (Pulp Fiction, Parasite, Rise of the Planet of the Apes, Ocean's Eleven).
      expect(args.where.status).toBe('ACTIVE')
      expect(args.where.posterUrl).toMatchObject({ in: expect.any(Array) })
      const paths = args.where.posterUrl.in as string[]
      expect(paths).toContain('/vQWk5YBFWF4bZaofAbv0tShwBvQ.jpg') // Pulp Fiction
      expect(paths).toContain('/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg') // Parasite
      expect(args.orderBy).toEqual([
        { imdbRating: { sort: 'desc', nulls: 'last' } },
        { imdbVotes: { sort: 'desc', nulls: 'last' } },
        { title: 'asc' },
      ])
    })

    it('falls through to step 3 (eras) when none of the genre films have backdrops', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce([makeFilm('film_g', 700, 'GenreFilm')])
        .mockResolvedValueOnce([makeFilm('film_e', 800, 'EraFilm')])
      mocks.pickBestBackdrop
        .mockResolvedValueOnce(null) // genre film: no backdrop
        .mockResolvedValueOnce('/era.jpg') // era film: has one
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: [], genres: ['genre_horror'], eras: ['era_2020s'] })
      )
      const body = await res.json()
      expect(body.source).toBe('era')
      expect(body.bannerValue).toEqual({ filmId: 'film_e', backdropPath: '/era.jpg' })
    })
  })

  describe('step 3: era cascade', () => {
    it('queries era-block posterPaths and returns BACKDROP/source=era', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([makeFilm('film_e', 800, 'EraFilm')])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/era.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(postRequest({ filmIds: [], genres: [], eras: ['era_2020s'] }))
      const body = await res.json()
      expect(body).toEqual({
        bannerType: 'BACKDROP',
        bannerValue: { filmId: 'film_e', backdropPath: '/era.jpg' },
        source: 'era',
      })

      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      const paths = args.where.posterUrl.in as string[]
      // 2020s era curated posters.
      expect(paths).toContain('/1g0dhYtq4irTY1GPXvft6k4YLjm.jpg') // Spider-Man: NWH
      expect(paths).toContain('/gDzOcq0pfeCeqMBwKIJlSmQpjkZ.jpg') // Dune
    })
  })

  describe('step 4: gradient fallback', () => {
    it('returns GRADIENT/midnight when all three arrays are empty', async () => {
      const { POST } = await import('@/app/api/onboarding/select-banner/route')
      const res = await POST(postRequest({ filmIds: [], genres: [], eras: [] }))
      const body = await res.json()
      expect(body).toEqual({
        bannerType: 'GRADIENT',
        bannerValue: 'midnight',
        source: 'gradient-fallback',
      })
      expect(mocks.prisma.film.findMany).not.toHaveBeenCalled()
      expect(mocks.pickBestBackdrop).not.toHaveBeenCalled()
    })

    it('returns GRADIENT when every cascade stage runs dry', async () => {
      // Every Prisma query returns no films, every pickBestBackdrop is null.
      const { POST } = await import('@/app/api/onboarding/select-banner/route')
      const res = await POST(
        postRequest({ filmIds: ['film_x'], genres: ['genre_horror'], eras: ['era_2020s'] })
      )
      const body = await res.json()
      expect(body.source).toBe('gradient-fallback')
      expect(body.bannerType).toBe('GRADIENT')
    })

    it('treats omitted body fields as empty arrays', async () => {
      const { POST } = await import('@/app/api/onboarding/select-banner/route')
      const res = await POST(postRequest({}))
      const body = await res.json()
      expect(body.source).toBe('gradient-fallback')
    })
  })

  describe('cascade ordering', () => {
    it('tries filmIds first even when genres and eras are also non-empty', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([makeFilm('film_a', 100, 'A')])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/from-screen3.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({
          filmIds: ['film_a'],
          genres: ['genre_horror'],
          eras: ['era_2020s'],
        })
      )
      const body = await res.json()
      expect(body.source).toBe('screen3')
      // Genre and era queries must NOT have run.
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
    })

    it('tries genres before eras when filmIds is empty', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([makeFilm('film_g', 700, 'GenreFilm')])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/from-genre.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: [], genres: ['genre_horror'], eras: ['era_2020s'] })
      )
      const body = await res.json()
      expect(body.source).toBe('genre')
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
    })
  })

  describe('input handling', () => {
    it('silently drops unknown era and genre IDs', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([makeFilm('film_e', 800, 'EraFilm')])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/era.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({
          filmIds: [],
          genres: ['genre_NOT_REAL', 'genre_horror_typo'],
          eras: ['era_FAKE', 'era_2020s'],
        })
      )
      const body = await res.json()
      expect(body.source).toBe('era')
      // Only era_2020s resolved → only era cascade runs.
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
    })

    it('falls to gradient when all era/genre IDs are unknown and filmIds is empty', async () => {
      const { POST } = await import('@/app/api/onboarding/select-banner/route')
      const res = await POST(
        postRequest({
          filmIds: [],
          genres: ['genre_NOT_REAL'],
          eras: ['era_NOT_REAL'],
        })
      )
      const body = await res.json()
      expect(body.source).toBe('gradient-fallback')
      expect(mocks.prisma.film.findMany).not.toHaveBeenCalled()
    })

    it('400 when filmIds is not an array', async () => {
      const { POST } = await import('@/app/api/onboarding/select-banner/route')
      const res = await POST(postRequest({ filmIds: 'film_a', genres: [], eras: [] }))
      expect(res.status).toBe(400)
    })

    it('400 when body is not JSON', async () => {
      const { POST } = await import('@/app/api/onboarding/select-banner/route')
      const req = new NextRequest('http://localhost/api/onboarding/select-banner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      })
      const res = await POST(req)
      expect(res.status).toBe(400)
    })
  })

  describe('cache', () => {
    it('cache hit returns cached payload without invoking Prisma or backdrop helper', async () => {
      const cached = {
        bannerType: 'BACKDROP' as const,
        bannerValue: { filmId: 'cached_film', backdropPath: '/cached.jpg' },
        source: 'screen3' as const,
      }
      mocks.redis.get.mockResolvedValue(cached)
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: ['film_a'], genres: ['genre_horror'], eras: ['era_2020s'] })
      )
      const body = await res.json()
      expect(body).toEqual(cached)
      expect(mocks.prisma.film.findMany).not.toHaveBeenCalled()
      expect(mocks.pickBestBackdrop).not.toHaveBeenCalled()
    })

    it('cache miss writes the response with TTL 86400 under the sorted-array key', async () => {
      const { POST } = await import('@/app/api/onboarding/select-banner/route')
      await POST(
        postRequest({
          filmIds: ['film_z', 'film_a'],
          genres: ['genre_thriller', 'genre_horror'],
          eras: ['era_2020s', 'era_2010s'],
        })
      )
      // cacheSet is fire-and-forget.
      await new Promise((r) => setTimeout(r, 10))

      expect(mocks.redis.set).toHaveBeenCalledTimes(1)
      const [key, value, opts] = mocks.redis.set.mock.calls[0]
      expect(key).toBe(
        'onboarding:banner:film_a,film_z:genre_horror,genre_thriller:era_2010s,era_2020s'
      )
      expect(opts).toEqual({ ex: 86400 })
      expect((value as { source: string }).source).toBe('gradient-fallback')
    })

    it('different selection orders collapse to the same cache key', async () => {
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      await POST(
        postRequest({
          filmIds: ['film_z', 'film_a'],
          genres: ['genre_thriller', 'genre_horror'],
          eras: ['era_2020s', 'era_2010s'],
        })
      )
      await new Promise((r) => setTimeout(r, 10))
      const firstKey = mocks.redis.set.mock.calls[0][0]
      mocks.redis.set.mockClear()

      await POST(
        postRequest({
          filmIds: ['film_a', 'film_z'],
          genres: ['genre_horror', 'genre_thriller'],
          eras: ['era_2010s', 'era_2020s'],
        })
      )
      await new Promise((r) => setTimeout(r, 10))
      expect(mocks.redis.set.mock.calls[0][0]).toBe(firstKey)
    })

    it('Redis unreachable on GET: cascade still runs, no 500', async () => {
      mocks.redis.get.mockRejectedValue(new Error('ECONNREFUSED'))
      mocks.prisma.film.findMany.mockResolvedValueOnce([makeFilm('film_a', 100, 'A')])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/x.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(postRequest({ filmIds: ['film_a'], genres: [], eras: [] }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.source).toBe('screen3')
    })

    it('Redis unreachable on SET: response still succeeds', async () => {
      mocks.redis.set.mockRejectedValue(new Error('ECONNREFUSED'))
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(postRequest({ filmIds: [], genres: [], eras: [] }))
      expect(res.status).toBe(200)
    })
  })
})
