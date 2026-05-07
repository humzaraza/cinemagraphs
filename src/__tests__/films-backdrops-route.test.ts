import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TMDBImagesResponse } from '@/lib/tmdb'

const mocks = vi.hoisted(() => ({
  prisma: {
    film: { findUnique: vi.fn() },
  },
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  getMovieImages: vi.fn(),
  apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  loggerChild: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/redis', () => ({ redis: mocks.redis, REDIS_AVAILABLE: true }))
vi.mock('@/lib/tmdb', () => ({ getMovieImages: mocks.getMovieImages }))
vi.mock('@/lib/logger', () => ({
  apiLogger: mocks.apiLogger,
  logger: { child: mocks.loggerChild },
}))

function routeContext(filmId: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: filmId }) }
}

const FILM_ID = 'film_godfather'
const TMDB_ID = 238

function imageRecord(overrides: Partial<TMDBImagesResponse['backdrops'][number]> = {}) {
  return {
    file_path: '/default.jpg',
    iso_639_1: null,
    vote_count: 1,
    vote_average: 5,
    width: 1920,
    height: 1080,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prisma.film.findUnique.mockResolvedValue({ id: FILM_ID, tmdbId: TMDB_ID })
  mocks.redis.get.mockResolvedValue(null)
  mocks.redis.set.mockResolvedValue('OK')
  mocks.getMovieImages.mockResolvedValue({ backdrops: [], logos: [], posters: [] })
})

describe('GET /api/films/[id]/backdrops', () => {
  it('returns 404 when the film does not exist', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost/api/films/missing/backdrops'), routeContext('missing'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('NOT_FOUND')
    expect(mocks.getMovieImages).not.toHaveBeenCalled()
  })

  it('cache miss triggers TMDB fetch with the film tmdbId', async () => {
    mocks.getMovieImages.mockResolvedValue({
      backdrops: [imageRecord({ file_path: '/a.jpg' })],
      logos: [],
      posters: [],
    })
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost'), routeContext(FILM_ID))
    expect(res.status).toBe(200)
    expect(mocks.getMovieImages).toHaveBeenCalledWith(TMDB_ID)
  })

  it('cache miss writes the filtered/sorted/capped projection to Redis under tmdb:backdrops:<filmId>', async () => {
    mocks.getMovieImages.mockResolvedValue({
      backdrops: [imageRecord({ file_path: '/a.jpg', vote_count: 99 })],
      logos: [],
      posters: [],
    })
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    await GET(new Request('http://localhost'), routeContext(FILM_ID))
    // cacheSet is fire-and-forget, wait a tick for it to fire
    await new Promise((r) => setTimeout(r, 10))
    expect(mocks.redis.set).toHaveBeenCalledWith(
      `tmdb:backdrops:${FILM_ID}`,
      expect.arrayContaining([
        expect.objectContaining({ file_path: '/a.jpg', vote_count: 99 }),
      ]),
      { ex: 604800 }
    )
  })

  it('cache hit returns cached projection without calling TMDB', async () => {
    const cached = [
      { file_path: '/cached.jpg', width: 1920, height: 1080, vote_count: 10, vote_average: 8 },
    ]
    mocks.redis.get.mockResolvedValue(cached)
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost'), routeContext(FILM_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backdrops).toEqual(cached)
    expect(mocks.getMovieImages).not.toHaveBeenCalled()
  })

  it('filters out backdrops with width < 1280', async () => {
    mocks.getMovieImages.mockResolvedValue({
      backdrops: [
        imageRecord({ file_path: '/small.jpg', width: 1000 }),
        imageRecord({ file_path: '/big.jpg', width: 1920 }),
      ],
      logos: [],
      posters: [],
    })
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost'), routeContext(FILM_ID))
    const body = await res.json()
    expect(body.backdrops.map((b: { file_path: string }) => b.file_path)).toEqual(['/big.jpg'])
  })

  it('filters out backdrops where iso_639_1 is non-null', async () => {
    mocks.getMovieImages.mockResolvedValue({
      backdrops: [
        imageRecord({ file_path: '/english.jpg', iso_639_1: 'en' }),
        imageRecord({ file_path: '/german.jpg', iso_639_1: 'de' }),
        imageRecord({ file_path: '/clean.jpg', iso_639_1: null }),
      ],
      logos: [],
      posters: [],
    })
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost'), routeContext(FILM_ID))
    const body = await res.json()
    expect(body.backdrops.map((b: { file_path: string }) => b.file_path)).toEqual(['/clean.jpg'])
  })

  it('sorts by vote_count desc with vote_average as tiebreaker', async () => {
    mocks.getMovieImages.mockResolvedValue({
      backdrops: [
        imageRecord({ file_path: '/mid_high_avg.jpg', vote_count: 5, vote_average: 9 }),
        imageRecord({ file_path: '/top.jpg', vote_count: 10, vote_average: 5 }),
        imageRecord({ file_path: '/mid_low_avg.jpg', vote_count: 5, vote_average: 7 }),
      ],
      logos: [],
      posters: [],
    })
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost'), routeContext(FILM_ID))
    const body = await res.json()
    expect(body.backdrops.map((b: { file_path: string }) => b.file_path)).toEqual([
      '/top.jpg',
      '/mid_high_avg.jpg',
      '/mid_low_avg.jpg',
    ])
  })

  it('caps results at 20', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      imageRecord({ file_path: `/img-${i}.jpg`, vote_count: 100 - i })
    )
    mocks.getMovieImages.mockResolvedValue({
      backdrops: many,
      logos: [],
      posters: [],
    })
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost'), routeContext(FILM_ID))
    const body = await res.json()
    expect(body.backdrops).toHaveLength(20)
    expect(body.backdrops[0].file_path).toBe('/img-0.jpg')
    expect(body.backdrops[19].file_path).toBe('/img-19.jpg')
  })

  it('returns { backdrops: [] } when TMDB returns zero backdrops', async () => {
    mocks.getMovieImages.mockResolvedValue({ backdrops: [], logos: [], posters: [] })
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost'), routeContext(FILM_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backdrops).toEqual([])
  })

  it('returns { backdrops: [] } with status 200 when TMDB throws', async () => {
    mocks.getMovieImages.mockRejectedValue(new Error('TMDB API error: 503 Service Unavailable'))
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost'), routeContext(FILM_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backdrops).toEqual([])
    expect(mocks.apiLogger.error).toHaveBeenCalled()
  })

  it('does NOT cache the empty array on TMDB error', async () => {
    mocks.getMovieImages.mockRejectedValue(new Error('TMDB API error: 503 Service Unavailable'))
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    await GET(new Request('http://localhost'), routeContext(FILM_ID))
    expect(mocks.redis.set).not.toHaveBeenCalled()
  })

  it('still fetches from TMDB when Redis get rejects (Redis unavailable)', async () => {
    mocks.redis.get.mockRejectedValue(new Error('Redis unreachable'))
    mocks.getMovieImages.mockResolvedValue({
      backdrops: [imageRecord({ file_path: '/a.jpg' })],
      logos: [],
      posters: [],
    })
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost'), routeContext(FILM_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backdrops).toHaveLength(1)
    expect(mocks.getMovieImages).toHaveBeenCalled()
  })

  it('response shape contains exactly file_path, width, height, vote_count, vote_average', async () => {
    mocks.getMovieImages.mockResolvedValue({
      backdrops: [
        imageRecord({
          file_path: '/foo.jpg',
          width: 1920,
          height: 1080,
          vote_count: 7,
          vote_average: 6.4,
          iso_639_1: null,
        }),
      ],
      logos: [],
      posters: [],
    })
    const { GET } = await import('@/app/api/films/[id]/backdrops/route')

    const res = await GET(new Request('http://localhost'), routeContext(FILM_ID))
    const body = await res.json()
    expect(body.backdrops).toHaveLength(1)
    expect(body.backdrops[0]).toEqual({
      file_path: '/foo.jpg',
      width: 1920,
      height: 1080,
      vote_count: 7,
      vote_average: 6.4,
    })
  })
})
