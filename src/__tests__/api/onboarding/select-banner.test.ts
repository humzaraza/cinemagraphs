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

    it('falls through to genre when none of the screen3 films have backdrops and no era is selected', async () => {
      // No eras → intersection skipped, era step skipped. Cascade goes
      // screen3 → genre.
      mocks.prisma.film.findMany
        .mockResolvedValueOnce([
          makeFilm('film_a', 100, 'A'),
          makeFilm('film_b', 200, 'B'),
        ]) // step 1 (screen3) query
        .mockResolvedValueOnce([
          makeFilm('film_genre', 700, 'GenreFilm'),
        ]) // step 4 (genre) query
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

  describe('step 2: era + genre intersection', () => {
    it('returns BACKDROP/source=era-genre-intersection when catalog has a matching film with a backdrop', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([
        makeFilm('film_intersect', 999, 'IntersectionFilm'),
      ])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/intersect.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: [], genres: ['genre_romance'], eras: ['era_1980s'] })
      )
      const body = await res.json()
      expect(body).toEqual({
        bannerType: 'BACKDROP',
        bannerValue: { filmId: 'film_intersect', backdropPath: '/intersect.jpg' },
        source: 'era-genre-intersection',
      })

      // Single Prisma call with the catalog intersection shape.
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where.status).toBe('ACTIVE')
      expect(args.where.OR).toEqual([
        {
          releaseDate: {
            gte: new Date('1980-01-01T00:00:00.000Z'),
            lt: new Date('1990-01-01T00:00:00.000Z'),
          },
        },
      ])
      expect(args.where.genres).toEqual({ hasSome: ['Romance'] })
      // Mosaic films are excluded so this is real catalog discovery.
      expect(args.where.posterUrl).toMatchObject({ notIn: expect.any(Array) })
      expect((args.where.posterUrl.notIn as string[]).length).toBe(57)
      expect(args.take).toBe(10)
      expect(args.orderBy).toEqual([
        { imdbRating: { sort: 'desc', nulls: 'last' } },
        { imdbVotes: { sort: 'desc', nulls: 'last' } },
        { title: 'asc' },
      ])
    })

    it('falls through to era when intersection returns no rows', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce([]) // intersection: empty
        .mockResolvedValueOnce([makeFilm('film_e', 800, 'EraFilm')]) // era step
      mocks.pickBestBackdrop.mockResolvedValueOnce('/era.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: [], genres: ['genre_horror'], eras: ['era_2020s'] })
      )
      const body = await res.json()
      expect(body.source).toBe('era')
      expect(body.bannerValue).toEqual({ filmId: 'film_e', backdropPath: '/era.jpg' })
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(2)
    })

    it('falls through to era when intersection has rows but none have a quality backdrop', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce([
          makeFilm('film_i1', 901, 'I1'),
          makeFilm('film_i2', 902, 'I2'),
          makeFilm('film_i3', 903, 'I3'),
        ]) // intersection: 3 films, no backdrops
        .mockResolvedValueOnce([makeFilm('film_e', 800, 'EraFilm')]) // era step
      mocks.pickBestBackdrop
        .mockResolvedValueOnce(null) // film_i1
        .mockResolvedValueOnce(null) // film_i2
        .mockResolvedValueOnce(null) // film_i3
        .mockResolvedValueOnce('/era.jpg') // film_e
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: [], genres: ['genre_horror'], eras: ['era_2020s'] })
      )
      const body = await res.json()
      expect(body.source).toBe('era')
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(2)
      expect(mocks.pickBestBackdrop).toHaveBeenCalledTimes(4)
    })

    it('skips intersection when only genres are present (no eras)', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([
        makeFilm('film_genre', 700, 'GenreFilm'),
      ])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/genre.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: [], genres: ['genre_thriller'], eras: [] })
      )
      const body = await res.json()
      expect(body.source).toBe('genre')
      // Single query: the genre-block step. Intersection skipped because
      // eras is empty.
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      // Genre-block query uses posterUrl IN, not the intersection shape.
      expect(args.where.posterUrl).toMatchObject({ in: expect.any(Array) })
    })

    it('skips intersection when only eras are present (no genres)', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([makeFilm('film_e', 800, 'EraFilm')])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/era.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(postRequest({ filmIds: [], genres: [], eras: ['era_2020s'] }))
      const body = await res.json()
      expect(body.source).toBe('era')
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
    })

    it('unions multiple eras and multiple genre tags in the intersection query', async () => {
      mocks.prisma.film.findMany.mockResolvedValueOnce([])
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      await POST(
        postRequest({
          filmIds: [],
          genres: ['genre_scifi', 'genre_drama'],
          eras: ['era_1980s', 'era_2020s'],
        })
      )

      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where.OR).toEqual([
        {
          releaseDate: {
            gte: new Date('1980-01-01T00:00:00.000Z'),
            lt: new Date('1990-01-01T00:00:00.000Z'),
          },
        },
        {
          releaseDate: {
            gte: new Date('2020-01-01T00:00:00.000Z'),
            lt: new Date('2030-01-01T00:00:00.000Z'),
          },
        },
      ])
      // Sci-fi maps to "Science Fiction" via the genre block's genreTag.
      const tags = args.where.genres.hasSome as string[]
      expect(tags).toContain('Drama')
      expect(tags).toContain('Science Fiction')
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

  describe('step 4: genre cascade', () => {
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

    it('falls through to gradient when both era step and genre step have no backdrop and intersection failed too', async () => {
      // intersection: 0 rows; era: 1 film with no backdrop; genre: 1 film with no backdrop.
      mocks.prisma.film.findMany
        .mockResolvedValueOnce([]) // intersection
        .mockResolvedValueOnce([makeFilm('film_e', 800, 'EraFilm')]) // era
        .mockResolvedValueOnce([makeFilm('film_g', 700, 'GenreFilm')]) // genre
      mocks.pickBestBackdrop
        .mockResolvedValueOnce(null) // era film
        .mockResolvedValueOnce(null) // genre film
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: [], genres: ['genre_horror'], eras: ['era_2020s'] })
      )
      const body = await res.json()
      expect(body.source).toBe('gradient-fallback')
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(3)
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
      // Intersection, era, and genre queries must NOT have run.
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
    })

    it('tries intersection before era-block, and era-block before genre-block, when filmIds is empty', async () => {
      // Intersection returns a film with a backdrop on the first call.
      // Era and genre block queries must NOT run.
      mocks.prisma.film.findMany.mockResolvedValueOnce([
        makeFilm('film_intersect', 999, 'I'),
      ])
      mocks.pickBestBackdrop.mockResolvedValueOnce('/from-intersection.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: [], genres: ['genre_horror'], eras: ['era_2020s'] })
      )
      const body = await res.json()
      expect(body.source).toBe('era-genre-intersection')
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
    })

    it('after intersection fails, tries era before genre', async () => {
      mocks.prisma.film.findMany
        .mockResolvedValueOnce([]) // intersection: empty
        .mockResolvedValueOnce([makeFilm('film_e', 800, 'EraFilm')]) // era: hits
      mocks.pickBestBackdrop.mockResolvedValueOnce('/from-era.jpg')
      const { POST } = await import('@/app/api/onboarding/select-banner/route')

      const res = await POST(
        postRequest({ filmIds: [], genres: ['genre_horror'], eras: ['era_2020s'] })
      )
      const body = await res.json()
      expect(body.source).toBe('era')
      // Genre-block query must NOT run because era succeeded.
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(2)
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
        'onboarding:banner:v2:film_a,film_z:genre_horror,genre_thriller:era_2010s,era_2020s'
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
