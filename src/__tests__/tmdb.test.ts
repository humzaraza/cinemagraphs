import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock calls are hoisted -- use vi.hoisted to create shared refs
const { mockGet, mockSet, mockDel } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockDel: vi.fn(),
}))

vi.mock('@/lib/redis', () => ({
  redis: { get: mockGet, set: mockSet, del: mockDel },
  REDIS_AVAILABLE: true,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {},
}))

import { getMovieImages, type TMDBImagesResponse } from '@/lib/tmdb'
import { KEYS } from '@/lib/cache'

const sampleResponse: TMDBImagesResponse = {
  backdrops: [
    {
      file_path: '/abc.jpg',
      iso_639_1: 'en',
      vote_count: 10,
      vote_average: 8,
      width: 1920,
      height: 1080,
    },
  ],
  logos: [],
  posters: [],
}

describe('getMovieImages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn() as unknown as typeof fetch
  })

  it('cache miss: fetches from TMDB and stores in Redis', async () => {
    mockGet.mockResolvedValue(null)
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleResponse,
    })

    const result = await getMovieImages(123)

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const urlArg = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(urlArg).toContain('/movie/123/images')
    expect(result).toEqual(sampleResponse)
    expect(mockSet).toHaveBeenCalledWith('tmdb:images:123', sampleResponse, { ex: 604800 })
  })

  it('cache hit: returns cached value without calling TMDB', async () => {
    mockGet.mockResolvedValue(sampleResponse)

    const result = await getMovieImages(123)

    expect(global.fetch).not.toHaveBeenCalled()
    expect(result).toEqual(sampleResponse)
  })

  it('includeImageLanguage produces a distinct cache key', async () => {
    mockGet.mockResolvedValue(null)
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleResponse,
    })

    await getMovieImages(123, { includeImageLanguage: 'en' })

    expect(mockGet).toHaveBeenCalledWith('tmdb:images:123:en')
    expect(mockGet).not.toHaveBeenCalledWith('tmdb:images:123')
  })

  it('TMDB error propagates and is not cached', async () => {
    mockGet.mockResolvedValue(null)
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    })

    await expect(getMovieImages(123)).rejects.toThrow(/TMDB API error: 500/)
    expect(mockSet).not.toHaveBeenCalled()
  })
})

describe('KEYS.tmdbImages', () => {
  it('without lang: produces tmdb:images:{id}', () => {
    expect(KEYS.tmdbImages(123)).toBe('tmdb:images:123')
  })

  it('with lang: produces tmdb:images:{id}:{lang}', () => {
    expect(KEYS.tmdbImages(123, 'en')).toBe('tmdb:images:123:en')
  })
})
