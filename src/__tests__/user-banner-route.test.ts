import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getMobileOrServerSession: vi.fn(),
  prisma: { user: { update: vi.fn() } },
  apiLogger: { error: vi.fn() },
  buildProfileResponse: vi.fn(),
}))

vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))
vi.mock('@/lib/profile-response', () => ({ buildProfileResponse: mocks.buildProfileResponse }))

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
  mocks.buildProfileResponse.mockResolvedValue(PROFILE_PAYLOAD)
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

  it('returns 501 for PHOTO bannerType in PR 1a', async () => {
    const { PATCH } = await import('@/app/api/user/banner/route')
    const res = await PATCH(patchRequest({ bannerType: 'PHOTO', bannerValue: 'https://img/x.jpg' }))
    expect(res.status).toBe(501)
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('returns 501 for BACKDROP bannerType in PR 1a', async () => {
    const { PATCH } = await import('@/app/api/user/banner/route')
    const res = await PATCH(patchRequest({ bannerType: 'BACKDROP', bannerValue: 'film_x' }))
    expect(res.status).toBe(501)
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
})
