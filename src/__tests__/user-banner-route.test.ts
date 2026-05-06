import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getMobileOrServerSession: vi.fn(),
  prisma: {
    user: { update: vi.fn(), findUnique: vi.fn() },
    film: { findUnique: vi.fn() },
  },
  apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  buildProfileResponse: vi.fn(),
  deleteUserBannerBlob: vi.fn(),
  validateBannerBlobPath: vi.fn(),
}))

vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))
vi.mock('@/lib/profile-response', () => ({ buildProfileResponse: mocks.buildProfileResponse }))
vi.mock('@/lib/banner-blob', () => ({
  deleteUserBannerBlob: mocks.deleteUserBannerBlob,
  validateBannerBlobPath: mocks.validateBannerBlobPath,
}))

const USER_ID = 'user_1'

function patchRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/user/banner', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const PROFILE_PAYLOAD = { user: { id: USER_ID, bannerType: 'GRADIENT', bannerValue: 'midnight' } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
  mocks.prisma.user.update.mockResolvedValue({ id: USER_ID })
  mocks.prisma.user.findUnique.mockResolvedValue({ bannerType: 'GRADIENT', bannerValue: 'midnight' })
  mocks.prisma.film.findUnique.mockResolvedValue(null)
  mocks.buildProfileResponse.mockResolvedValue(PROFILE_PAYLOAD)
  mocks.deleteUserBannerBlob.mockResolvedValue(undefined)
  mocks.validateBannerBlobPath.mockReturnValue(true)
})

describe('PATCH /api/user/banner', () => {
  it('returns 401 when unauthenticated', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue(null)
    const { PATCH } = await import('@/app/api/user/banner/route')
    const res = await PATCH(patchRequest({ bannerType: 'GRADIENT', bannerValue: 'midnight' }))
    expect(res.status).toBe(401)
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('persists a valid GRADIENT banner and returns the full profile shape', async () => {
    const { PATCH } = await import('@/app/api/user/banner/route')
    const res = await PATCH(patchRequest({ bannerType: 'GRADIENT', bannerValue: 'ember' }))
    expect(res.status).toBe(200)
    expect(mocks.prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { bannerType: 'GRADIENT', bannerValue: 'ember' },
    })
    const body = await res.json()
    expect(body).toEqual(PROFILE_PAYLOAD)
  })

  it('returns 400 for an invalid bannerType', async () => {
    const { PATCH } = await import('@/app/api/user/banner/route')
    const res = await PATCH(patchRequest({ bannerType: 'NEON', bannerValue: 'midnight' }))
    expect(res.status).toBe(400)
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('returns 400 for an empty bannerValue', async () => {
    const { PATCH } = await import('@/app/api/user/banner/route')
    const res = await PATCH(patchRequest({ bannerType: 'GRADIENT', bannerValue: '' }))
    expect(res.status).toBe(400)
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('returns 400 with the valid key list for an unknown GRADIENT key', async () => {
    const { PATCH } = await import('@/app/api/user/banner/route')
    const res = await PATCH(patchRequest({ bannerType: 'GRADIENT', bannerValue: 'aurora' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.validKeys).toEqual([
      'midnight',
      'ember',
      'ocean',
      'dusk',
      'forest',
      'gold',
      'rose',
      'steel',
    ])
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('accepts every documented GRADIENT key', async () => {
    const { PATCH } = await import('@/app/api/user/banner/route')
    for (const key of ['midnight', 'ember', 'ocean', 'dusk', 'forest', 'gold', 'rose', 'steel']) {
      const res = await PATCH(patchRequest({ bannerType: 'GRADIENT', bannerValue: key }))
      expect(res.status).toBe(200)
    }
  })

  describe('BACKDROP', () => {
    it('legacy string filmId: validates against catalog and persists as JSON-encoded object with null backdropPath', async () => {
      mocks.prisma.film.findUnique.mockResolvedValue({ id: 'film_godfather' })
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(patchRequest({ bannerType: 'BACKDROP', bannerValue: 'film_godfather' }))
      expect(res.status).toBe(200)
      expect(mocks.prisma.film.findUnique).toHaveBeenCalledWith({
        where: { id: 'film_godfather' },
        select: { id: true },
      })
      expect(mocks.prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: {
          bannerType: 'BACKDROP',
          bannerValue: JSON.stringify({ filmId: 'film_godfather', backdropPath: null }),
        },
      })
    })

    it('object shape with backdropPath null: persists as JSON-encoded object', async () => {
      mocks.prisma.film.findUnique.mockResolvedValue({ id: 'film_godfather' })
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({
          bannerType: 'BACKDROP',
          bannerValue: { filmId: 'film_godfather', backdropPath: null },
        })
      )
      expect(res.status).toBe(200)
      expect(mocks.prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: {
          bannerType: 'BACKDROP',
          bannerValue: JSON.stringify({ filmId: 'film_godfather', backdropPath: null }),
        },
      })
    })

    it('object shape with non-null backdropPath: persists exactly as supplied', async () => {
      mocks.prisma.film.findUnique.mockResolvedValue({ id: 'film_godfather' })
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({
          bannerType: 'BACKDROP',
          bannerValue: { filmId: 'film_godfather', backdropPath: '/abc123.jpg' },
        })
      )
      expect(res.status).toBe(200)
      expect(mocks.prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: {
          bannerType: 'BACKDROP',
          bannerValue: JSON.stringify({
            filmId: 'film_godfather',
            backdropPath: '/abc123.jpg',
          }),
        },
      })
    })

    it('returns 400 when the filmId does not exist (legacy string input)', async () => {
      mocks.prisma.film.findUnique.mockResolvedValue(null)
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(patchRequest({ bannerType: 'BACKDROP', bannerValue: 'film_unknown' }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('film_unknown')
      expect(mocks.prisma.user.update).not.toHaveBeenCalled()
    })

    it('returns 400 when the filmId does not exist (object input)', async () => {
      mocks.prisma.film.findUnique.mockResolvedValue(null)
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({
          bannerType: 'BACKDROP',
          bannerValue: { filmId: 'film_unknown', backdropPath: null },
        })
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('film_unknown')
      expect(mocks.prisma.user.update).not.toHaveBeenCalled()
    })

    it('returns 400 when bannerValue is an object missing filmId', async () => {
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({ bannerType: 'BACKDROP', bannerValue: { backdropPath: '/abc.jpg' } })
      )
      expect(res.status).toBe(400)
      expect(mocks.prisma.film.findUnique).not.toHaveBeenCalled()
      expect(mocks.prisma.user.update).not.toHaveBeenCalled()
    })

    it('returns 400 when bannerValue.backdropPath is a number', async () => {
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({
          bannerType: 'BACKDROP',
          bannerValue: { filmId: 'film_godfather', backdropPath: 42 },
        })
      )
      expect(res.status).toBe(400)
      expect(mocks.prisma.user.update).not.toHaveBeenCalled()
    })

    it('returns 400 when bannerValue.backdropPath is an empty string', async () => {
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({
          bannerType: 'BACKDROP',
          bannerValue: { filmId: 'film_godfather', backdropPath: '' },
        })
      )
      expect(res.status).toBe(400)
      expect(mocks.prisma.user.update).not.toHaveBeenCalled()
    })

    it('returns 400 when bannerValue.backdropPath does not start with "/"', async () => {
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({
          bannerType: 'BACKDROP',
          bannerValue: { filmId: 'film_godfather', backdropPath: 'abc.jpg' },
        })
      )
      expect(res.status).toBe(400)
      expect(mocks.prisma.user.update).not.toHaveBeenCalled()
    })

    it('returns 400 when bannerValue is an array', async () => {
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({ bannerType: 'BACKDROP', bannerValue: ['film_godfather'] })
      )
      expect(res.status).toBe(400)
      expect(mocks.prisma.user.update).not.toHaveBeenCalled()
    })

    it('returns 400 when bannerValue is null', async () => {
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(patchRequest({ bannerType: 'BACKDROP', bannerValue: null }))
      expect(res.status).toBe(400)
      expect(mocks.prisma.user.update).not.toHaveBeenCalled()
    })
  })

  describe('PHOTO', () => {
    it('persists when validateBannerBlobPath returns true', async () => {
      mocks.validateBannerBlobPath.mockReturnValue(true)
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({ bannerType: 'PHOTO', bannerValue: 'banners/user_1/123.jpg' })
      )
      expect(res.status).toBe(200)
      expect(mocks.validateBannerBlobPath).toHaveBeenCalledWith('banners/user_1/123.jpg')
      expect(mocks.prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { bannerType: 'PHOTO', bannerValue: 'banners/user_1/123.jpg' },
      })
    })

    it('returns 400 when validateBannerBlobPath returns false', async () => {
      mocks.validateBannerBlobPath.mockReturnValue(false)
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({ bannerType: 'PHOTO', bannerValue: 'avatars/user_1/123.jpg' })
      )
      expect(res.status).toBe(400)
      expect(mocks.prisma.user.update).not.toHaveBeenCalled()
    })
  })

  describe('previous-blob cleanup', () => {
    it('fires deleteUserBannerBlob when transitioning from PHOTO to GRADIENT', async () => {
      mocks.prisma.user.findUnique.mockResolvedValue({
        bannerType: 'PHOTO',
        bannerValue: 'banners/user_1/old.jpg',
      })
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(patchRequest({ bannerType: 'GRADIENT', bannerValue: 'ember' }))
      expect(res.status).toBe(200)
      expect(mocks.deleteUserBannerBlob).toHaveBeenCalledWith({
        id: USER_ID,
        bannerType: 'PHOTO',
        bannerValue: 'banners/user_1/old.jpg',
      })
    })

    it('fires deleteUserBannerBlob when transitioning from PHOTO to BACKDROP', async () => {
      mocks.prisma.user.findUnique.mockResolvedValue({
        bannerType: 'PHOTO',
        bannerValue: 'banners/user_1/old.jpg',
      })
      mocks.prisma.film.findUnique.mockResolvedValue({ id: 'film_x' })
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(patchRequest({ bannerType: 'BACKDROP', bannerValue: 'film_x' }))
      expect(res.status).toBe(200)
      expect(mocks.deleteUserBannerBlob).toHaveBeenCalledWith({
        id: USER_ID,
        bannerType: 'PHOTO',
        bannerValue: 'banners/user_1/old.jpg',
      })
    })

    it('fires deleteUserBannerBlob on PHOTO to PHOTO replacement', async () => {
      mocks.prisma.user.findUnique.mockResolvedValue({
        bannerType: 'PHOTO',
        bannerValue: 'banners/user_1/old.jpg',
      })
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(
        patchRequest({ bannerType: 'PHOTO', bannerValue: 'banners/user_1/new.jpg' })
      )
      expect(res.status).toBe(200)
      expect(mocks.deleteUserBannerBlob).toHaveBeenCalledWith({
        id: USER_ID,
        bannerType: 'PHOTO',
        bannerValue: 'banners/user_1/old.jpg',
      })
    })

    it('does not call deleteUserBannerBlob when previous bannerType was GRADIENT', async () => {
      mocks.prisma.user.findUnique.mockResolvedValue({
        bannerType: 'GRADIENT',
        bannerValue: 'midnight',
      })
      const { PATCH } = await import('@/app/api/user/banner/route')
      await PATCH(patchRequest({ bannerType: 'PHOTO', bannerValue: 'banners/user_1/new.jpg' }))
      expect(mocks.deleteUserBannerBlob).not.toHaveBeenCalled()
    })

    it('still returns 200 when deleteUserBannerBlob throws', async () => {
      mocks.prisma.user.findUnique.mockResolvedValue({
        bannerType: 'PHOTO',
        bannerValue: 'banners/user_1/old.jpg',
      })
      mocks.deleteUserBannerBlob.mockRejectedValue(new Error('cleanup boom'))
      const { PATCH } = await import('@/app/api/user/banner/route')
      const res = await PATCH(patchRequest({ bannerType: 'GRADIENT', bannerValue: 'ember' }))
      expect(res.status).toBe(200)
      expect(mocks.prisma.user.update).toHaveBeenCalled()
    })
  })
})
