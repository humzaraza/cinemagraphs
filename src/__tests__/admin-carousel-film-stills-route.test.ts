import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  prisma: {
    film: {
      findUnique: vi.fn(),
    },
  },
  getMovieImages: vi.fn(),
}))

vi.mock('@/lib/middleware', () => ({
  requireRole: mocks.requireRole,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: mocks.prisma,
}))

vi.mock('@/lib/tmdb', () => ({
  getMovieImages: mocks.getMovieImages,
}))

const FILM_ID = 'film-1'

function stillsRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/carousel/film/${FILM_ID}/stills`,
    { method: 'GET' },
  )
}

function params(filmId: string) {
  return { params: Promise.resolve({ filmId }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireRole.mockResolvedValue({
    authorized: true,
    session: { user: { id: 'u1', role: 'ADMIN' } },
  })
})

describe('GET /api/admin/carousel/film/[filmId]/stills', () => {
  it('returns the requireRole errorResponse when caller is not admin', async () => {
    const errorResponse = Response.json({ error: 'forbidden' }, { status: 403 })
    mocks.requireRole.mockResolvedValue({
      authorized: false,
      session: null,
      errorResponse,
    })
    const { GET } = await import(
      '@/app/api/admin/carousel/film/[filmId]/stills/route'
    )
    const res = await GET(stillsRequest(), params(FILM_ID))
    expect(res.status).toBe(403)
    expect(mocks.prisma.film.findUnique).not.toHaveBeenCalled()
  })

  it('returns 400 when filmId is empty', async () => {
    const { GET } = await import(
      '@/app/api/admin/carousel/film/[filmId]/stills/route'
    )
    const res = await GET(stillsRequest(), params(''))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'filmId is required' })
  })

  it('returns 404 when film does not exist', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(null)
    const { GET } = await import(
      '@/app/api/admin/carousel/film/[filmId]/stills/route'
    )
    const res = await GET(stillsRequest(), params(FILM_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: 'Film not found' })
  })

  it('returns empty backdrops when film has no tmdbId', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({ tmdbId: null })
    const { GET } = await import(
      '@/app/api/admin/carousel/film/[filmId]/stills/route'
    )
    const res = await GET(stillsRequest(), params(FILM_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ backdrops: [] })
    expect(mocks.getMovieImages).not.toHaveBeenCalled()
  })

  it('returns shaped, sorted backdrops on happy path', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({ tmdbId: 12345 })
    mocks.getMovieImages.mockResolvedValue({
      backdrops: [
        { file_path: '/low.jpg', width: 1920, height: 1080, vote_average: 5, vote_count: 1 },
        { file_path: '/high.jpg', width: 3840, height: 2160, vote_average: 8, vote_count: 100 },
        { file_path: '/mid.jpg', width: 1280, height: 720, vote_average: 9, vote_count: 50 },
      ],
      logos: [],
      posters: [],
    })
    const { GET } = await import(
      '@/app/api/admin/carousel/film/[filmId]/stills/route'
    )
    const res = await GET(stillsRequest(), params(FILM_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backdrops).toHaveLength(3)
    expect(body.backdrops[0].url).toBe('https://image.tmdb.org/t/p/w1280/high.jpg')
    expect(body.backdrops[0].thumbUrl).toBe('https://image.tmdb.org/t/p/w342/high.jpg')
    expect(body.backdrops[0].voteCount).toBe(100)
    expect(body.backdrops[1].url).toContain('/mid.jpg')
    expect(body.backdrops[2].url).toContain('/low.jpg')
    for (const b of body.backdrops) {
      expect(b.url).toContain('/w1280')
      expect(b.thumbUrl).toContain('/w342')
      expect(b.aspectRatio).toBeCloseTo(b.width / b.height)
    }
  })

  it('returns empty backdrops when TMDB throws', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({ tmdbId: 12345 })
    mocks.getMovieImages.mockRejectedValue(new Error('TMDB boom'))
    const { GET } = await import(
      '@/app/api/admin/carousel/film/[filmId]/stills/route'
    )
    const res = await GET(stillsRequest(), params(FILM_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ backdrops: [] })
  })

  it('handles zero-height image without dividing by zero', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({ tmdbId: 12345 })
    mocks.getMovieImages.mockResolvedValue({
      backdrops: [
        { file_path: '/zero.jpg', width: 1920, height: 0, vote_average: 7, vote_count: 10 },
      ],
      logos: [],
      posters: [],
    })
    const { GET } = await import(
      '@/app/api/admin/carousel/film/[filmId]/stills/route'
    )
    const res = await GET(stillsRequest(), params(FILM_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backdrops[0].aspectRatio).toBe(0)
    expect(Number.isFinite(body.backdrops[0].aspectRatio)).toBe(true)
  })
})
