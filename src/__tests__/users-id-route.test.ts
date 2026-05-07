import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    follow: { count: vi.fn() },
    watchlist: { findMany: vi.fn() },
    list: { findMany: vi.fn() },
    film: { findUnique: vi.fn() },
  },
  apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))

const USER_ID = 'user_target'

function routeContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function getRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/users/${USER_ID}`)
}

const baseUserRow = {
  id: USER_ID,
  name: 'Alice',
  username: 'alice',
  image: null,
  bio: 'hi',
  createdAt: new Date('2026-01-01'),
  isPublic: true,
  bannerType: 'GRADIENT',
  bannerValue: 'midnight',
  userReviews: [],
  liveReactions: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prisma.user.findUnique.mockResolvedValue({ ...baseUserRow })
  mocks.prisma.follow.count.mockResolvedValue(0)
  mocks.prisma.watchlist.findMany.mockResolvedValue([])
  mocks.prisma.list.findMany.mockResolvedValue([])
  mocks.prisma.film.findUnique.mockResolvedValue(null)
})

describe('GET /api/users/[id] banner fields', () => {
  it('returns 404 when the user is not public', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ ...baseUserRow, isPublic: false })
    const { GET } = await import('@/app/api/users/[id]/route')
    const res = await GET(getRequest(), routeContext(USER_ID))
    expect(res.status).toBe(404)
  })

  it('returns bannerType, bannerValue and bannerFilm: null for a GRADIENT banner', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      ...baseUserRow,
      bannerType: 'GRADIENT',
      bannerValue: 'ember',
    })
    const { GET } = await import('@/app/api/users/[id]/route')
    const res = await GET(getRequest(), routeContext(USER_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.bannerType).toBe('GRADIENT')
    expect(body.user.bannerValue).toBe('ember')
    expect(body.user.bannerFilm).toBeNull()
    expect(mocks.prisma.film.findUnique).not.toHaveBeenCalled()
  })

  it('returns bannerFilm: null for PHOTO banners (no fallback film needed)', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      ...baseUserRow,
      bannerType: 'PHOTO',
      bannerValue: 'banners/user_target/abc.jpg',
    })
    const { GET } = await import('@/app/api/users/[id]/route')
    const res = await GET(getRequest(), routeContext(USER_ID))
    const body = await res.json()
    expect(body.user.bannerType).toBe('PHOTO')
    expect(body.user.bannerValue).toBe('banners/user_target/abc.jpg')
    expect(body.user.bannerFilm).toBeNull()
    expect(mocks.prisma.film.findUnique).not.toHaveBeenCalled()
  })

  it('hydrates bannerFilm with backdropUrl when BACKDROP has a null backdropPath', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      ...baseUserRow,
      bannerType: 'BACKDROP',
      bannerValue: JSON.stringify({ filmId: 'film_godfather', backdropPath: null }),
    })
    mocks.prisma.film.findUnique.mockResolvedValue({ backdropUrl: '/godfather-default.jpg' })
    const { GET } = await import('@/app/api/users/[id]/route')
    const res = await GET(getRequest(), routeContext(USER_ID))
    const body = await res.json()
    expect(body.user.bannerType).toBe('BACKDROP')
    expect(body.user.bannerFilm).toEqual({ backdropUrl: '/godfather-default.jpg' })
    expect(mocks.prisma.film.findUnique).toHaveBeenCalledWith({
      where: { id: 'film_godfather' },
      select: { backdropUrl: true },
    })
  })

  it('does NOT fetch a fallback film when BACKDROP has a non-null backdropPath', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      ...baseUserRow,
      bannerType: 'BACKDROP',
      bannerValue: JSON.stringify({ filmId: 'film_godfather', backdropPath: '/specific.jpg' }),
    })
    const { GET } = await import('@/app/api/users/[id]/route')
    const res = await GET(getRequest(), routeContext(USER_ID))
    const body = await res.json()
    expect(body.user.bannerFilm).toBeNull()
    expect(mocks.prisma.film.findUnique).not.toHaveBeenCalled()
  })

  it('hydrates bannerFilm for legacy plain-string BACKDROP bannerValue (parsed as filmId, null path)', async () => {
    // Defensive: even after the migration, an unmigrated row could leak
    // through. parseBackdropBannerValue treats a plain string as a
    // filmId with null backdropPath, which triggers the film lookup.
    mocks.prisma.user.findUnique.mockResolvedValue({
      ...baseUserRow,
      bannerType: 'BACKDROP',
      bannerValue: 'film_legacy',
    })
    mocks.prisma.film.findUnique.mockResolvedValue({ backdropUrl: '/legacy.jpg' })
    const { GET } = await import('@/app/api/users/[id]/route')
    const res = await GET(getRequest(), routeContext(USER_ID))
    const body = await res.json()
    expect(body.user.bannerFilm).toEqual({ backdropUrl: '/legacy.jpg' })
    expect(mocks.prisma.film.findUnique).toHaveBeenCalledWith({
      where: { id: 'film_legacy' },
      select: { backdropUrl: true },
    })
  })

  it('returns bannerFilm: null when BACKDROP bannerValue is malformed JSON', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      ...baseUserRow,
      bannerType: 'BACKDROP',
      bannerValue: '{not json}',
    })
    // Plain malformed JSON starts with `{` but doesn't parse, so the
    // helper returns ok:false and no film lookup happens.
    const { GET } = await import('@/app/api/users/[id]/route')
    const res = await GET(getRequest(), routeContext(USER_ID))
    const body = await res.json()
    expect(body.user.bannerType).toBe('BACKDROP')
    expect(body.user.bannerFilm).toBeNull()
    expect(mocks.prisma.film.findUnique).not.toHaveBeenCalled()
  })

  it('returns bannerFilm: null when the referenced film does not exist', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      ...baseUserRow,
      bannerType: 'BACKDROP',
      bannerValue: JSON.stringify({ filmId: 'film_missing', backdropPath: null }),
    })
    mocks.prisma.film.findUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/users/[id]/route')
    const res = await GET(getRequest(), routeContext(USER_ID))
    const body = await res.json()
    expect(body.user.bannerFilm).toBeNull()
  })
})
