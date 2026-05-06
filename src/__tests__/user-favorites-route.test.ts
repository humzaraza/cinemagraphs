import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getMobileOrServerSession: vi.fn(),
  prisma: {
    film: { findMany: vi.fn() },
    userReview: { findMany: vi.fn() },
    user: { update: vi.fn() },
  },
  apiLogger: { error: vi.fn() },
  buildProfileResponse: vi.fn(),
}))

vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))
vi.mock('@/lib/profile-response', () => ({ buildProfileResponse: mocks.buildProfileResponse }))

const USER_ID = 'user_1'

function patchRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/user/favorites', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const PROFILE_PAYLOAD = { user: { id: USER_ID, favoriteFilms: [] } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
  mocks.prisma.user.update.mockResolvedValue({ id: USER_ID })
  mocks.buildProfileResponse.mockResolvedValue(PROFILE_PAYLOAD)
})

describe('PATCH /api/user/favorites', () => {
  it('returns 401 when unauthenticated', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue(null)
    const { PATCH } = await import('@/app/api/user/favorites/route')
    const res = await PATCH(patchRequest({ favoriteFilms: [] }))
    expect(res.status).toBe(401)
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('accepts an empty list and persists it without DB lookups', async () => {
    const { PATCH } = await import('@/app/api/user/favorites/route')
    const res = await PATCH(patchRequest({ favoriteFilms: [] }))
    expect(res.status).toBe(200)
    expect(mocks.prisma.film.findMany).not.toHaveBeenCalled()
    expect(mocks.prisma.userReview.findMany).not.toHaveBeenCalled()
    expect(mocks.prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { favoriteFilms: [] },
    })
  })

  it('accepts up to 4 films when all exist and the user has reviewed each', async () => {
    const ids = ['f1', 'f2', 'f3', 'f4']
    mocks.prisma.film.findMany.mockResolvedValue(ids.map((id) => ({ id })))
    mocks.prisma.userReview.findMany.mockResolvedValue(ids.map((filmId) => ({ filmId })))
    const { PATCH } = await import('@/app/api/user/favorites/route')
    const res = await PATCH(patchRequest({ favoriteFilms: ids }))
    expect(res.status).toBe(200)
    expect(mocks.prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { favoriteFilms: ids },
    })
  })

  it('returns 400 when the array exceeds 4 entries', async () => {
    const { PATCH } = await import('@/app/api/user/favorites/route')
    const res = await PATCH(patchRequest({ favoriteFilms: ['f1', 'f2', 'f3', 'f4', 'f5'] }))
    expect(res.status).toBe(400)
    expect(mocks.prisma.film.findMany).not.toHaveBeenCalled()
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('returns 400 when favoriteFilms is not an array', async () => {
    const { PATCH } = await import('@/app/api/user/favorites/route')
    const res = await PATCH(patchRequest({ favoriteFilms: 'f1' }))
    expect(res.status).toBe(400)
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('returns 400 when an entry is not a string', async () => {
    const { PATCH } = await import('@/app/api/user/favorites/route')
    const res = await PATCH(patchRequest({ favoriteFilms: ['f1', 42] }))
    expect(res.status).toBe(400)
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('returns 400 with the offending id when a film does not exist', async () => {
    mocks.prisma.film.findMany.mockResolvedValue([{ id: 'f1' }]) // f2 missing
    mocks.prisma.userReview.findMany.mockResolvedValue([{ filmId: 'f1' }])
    const { PATCH } = await import('@/app/api/user/favorites/route')
    const res = await PATCH(patchRequest({ favoriteFilms: ['f1', 'f2'] }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('f2')
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('returns 400 with the offending id when the user has not reviewed a film', async () => {
    mocks.prisma.film.findMany.mockResolvedValue([{ id: 'f1' }, { id: 'f2' }])
    mocks.prisma.userReview.findMany.mockResolvedValue([{ filmId: 'f1' }]) // no review for f2
    const { PATCH } = await import('@/app/api/user/favorites/route')
    const res = await PATCH(patchRequest({ favoriteFilms: ['f1', 'f2'] }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('f2')
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })
})
