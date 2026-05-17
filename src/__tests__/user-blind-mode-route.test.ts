import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    userFilmBlindMode: { findMany: vi.fn(), upsert: vi.fn() },
    film: { findUnique: vi.fn() },
  },
  apiLogger: { error: vi.fn() },
  getMobileOrServerSession: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))
vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))

const USER_ID = 'u1'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
})

describe('GET /api/user/blind-mode', () => {
  it('rejects unauthenticated requests with 401', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue(null)
    const { GET } = await import('@/app/api/user/blind-mode/route')
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns defaults, perFilm map, and hasSeenBlindModeTooltip', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      blindUnwatchedDefault: true,
      blindReviewedDefault: false,
      hasSeenBlindModeTooltip: false,
    })
    mocks.prisma.userFilmBlindMode.findMany.mockResolvedValue([
      { filmId: 'f1', isBlind: true },
      { filmId: 'f2', isBlind: false },
    ])
    const { GET } = await import('@/app/api/user/blind-mode/route')
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      blindUnwatchedDefault: true,
      blindReviewedDefault: false,
      perFilm: { f1: true, f2: false },
      hasSeenBlindModeTooltip: false,
    })
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: {
        blindUnwatchedDefault: true,
        blindReviewedDefault: true,
        hasSeenBlindModeTooltip: true,
      },
    })
  })

  it('returns 404 when the user row is missing', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null)
    mocks.prisma.userFilmBlindMode.findMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/user/blind-mode/route')
    const res = await GET()
    expect(res.status).toBe(404)
  })
})

function patchRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/user/blind-mode/defaults', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/user/blind-mode/defaults', () => {
  it('rejects unauthenticated requests', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue(null)
    const { PATCH } = await import('@/app/api/user/blind-mode/defaults/route')
    const res = await PATCH(patchRequest({ blindUnwatchedDefault: true }))
    expect(res.status).toBe(401)
  })

  it('updates only boolean fields and ignores others', async () => {
    mocks.prisma.user.update.mockResolvedValue({
      blindUnwatchedDefault: true,
      blindReviewedDefault: false,
      hasSeenBlindModeTooltip: false,
    })
    const { PATCH } = await import('@/app/api/user/blind-mode/defaults/route')
    const res = await PATCH(
      patchRequest({ blindUnwatchedDefault: true, blindReviewedDefault: 'nope', somethingElse: 'x' }),
    )
    expect(res.status).toBe(200)
    expect(mocks.prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { blindUnwatchedDefault: true },
      select: {
        blindUnwatchedDefault: true,
        blindReviewedDefault: true,
        hasSeenBlindModeTooltip: true,
      },
    })
  })

  it('returns 400 when no recognized fields are present', async () => {
    const { PATCH } = await import('@/app/api/user/blind-mode/defaults/route')
    const res = await PATCH(patchRequest({ foo: 'bar' }))
    expect(res.status).toBe(400)
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('returns 400 on invalid JSON', async () => {
    const bad = new NextRequest('http://localhost/api/user/blind-mode/defaults', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    const { PATCH } = await import('@/app/api/user/blind-mode/defaults/route')
    const res = await PATCH(bad)
    expect(res.status).toBe(400)
  })

  it('accepts patching both fields at once', async () => {
    mocks.prisma.user.update.mockResolvedValue({
      blindUnwatchedDefault: true,
      blindReviewedDefault: true,
      hasSeenBlindModeTooltip: false,
    })
    const { PATCH } = await import('@/app/api/user/blind-mode/defaults/route')
    const res = await PATCH(
      patchRequest({ blindUnwatchedDefault: true, blindReviewedDefault: true }),
    )
    expect(res.status).toBe(200)
    expect(mocks.prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { blindUnwatchedDefault: true, blindReviewedDefault: true },
      select: {
        blindUnwatchedDefault: true,
        blindReviewedDefault: true,
        hasSeenBlindModeTooltip: true,
      },
    })
  })

  it('accepts hasSeenBlindModeTooltip and persists it', async () => {
    mocks.prisma.user.update.mockResolvedValue({
      blindUnwatchedDefault: false,
      blindReviewedDefault: false,
      hasSeenBlindModeTooltip: true,
    })
    const { PATCH } = await import('@/app/api/user/blind-mode/defaults/route')
    const res = await PATCH(patchRequest({ hasSeenBlindModeTooltip: true }))
    expect(res.status).toBe(200)
    expect(mocks.prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { hasSeenBlindModeTooltip: true },
      select: {
        blindUnwatchedDefault: true,
        blindReviewedDefault: true,
        hasSeenBlindModeTooltip: true,
      },
    })
    const body = await res.json()
    expect(body.hasSeenBlindModeTooltip).toBe(true)
  })

  it('partial update with only hasSeenBlindModeTooltip does not clobber the other defaults', async () => {
    mocks.prisma.user.update.mockResolvedValue({
      blindUnwatchedDefault: true,
      blindReviewedDefault: true,
      hasSeenBlindModeTooltip: true,
    })
    const { PATCH } = await import('@/app/api/user/blind-mode/defaults/route')
    const res = await PATCH(patchRequest({ hasSeenBlindModeTooltip: true }))
    expect(res.status).toBe(200)
    // The data payload contains ONLY the field that was sent — blindUnwatchedDefault
    // and blindReviewedDefault must not appear, so Prisma leaves them untouched.
    expect(mocks.prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { hasSeenBlindModeTooltip: true },
      select: {
        blindUnwatchedDefault: true,
        blindReviewedDefault: true,
        hasSeenBlindModeTooltip: true,
      },
    })
    const call = mocks.prisma.user.update.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(Object.keys(call.data)).toEqual(['hasSeenBlindModeTooltip'])
  })

  it('rejects non-boolean hasSeenBlindModeTooltip and reports 400 when nothing else is valid', async () => {
    const { PATCH } = await import('@/app/api/user/blind-mode/defaults/route')
    const res = await PATCH(patchRequest({ hasSeenBlindModeTooltip: 'yes' }))
    expect(res.status).toBe(400)
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })
})

const FILM_ID = 'film-1'

function putRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/user/blind-mode/film/${FILM_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function callPUT(body: unknown) {
  const { PUT } = await import('@/app/api/user/blind-mode/film/[filmId]/route')
  return PUT(putRequest(body), { params: Promise.resolve({ filmId: FILM_ID }) })
}

describe('PUT /api/user/blind-mode/film/[filmId]', () => {
  it('rejects unauthenticated requests', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue(null)
    const res = await callPUT({ isBlind: true })
    expect(res.status).toBe(401)
  })

  it('rejects when isBlind is missing or not boolean', async () => {
    let res = await callPUT({})
    expect(res.status).toBe(400)
    res = await callPUT({ isBlind: 'yes' })
    expect(res.status).toBe(400)
  })

  it('returns 404 when film does not exist', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(null)
    const res = await callPUT({ isBlind: true })
    expect(res.status).toBe(404)
  })

  it('upserts the override on valid input', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({ id: FILM_ID })
    const updatedAt = new Date('2026-05-17T00:00:00Z')
    mocks.prisma.userFilmBlindMode.upsert.mockResolvedValue({
      filmId: FILM_ID,
      isBlind: true,
      updatedAt,
    })
    const res = await callPUT({ isBlind: true })
    expect(res.status).toBe(200)
    expect(mocks.prisma.userFilmBlindMode.upsert).toHaveBeenCalledWith({
      where: { userId_filmId: { userId: USER_ID, filmId: FILM_ID } },
      create: { userId: USER_ID, filmId: FILM_ID, isBlind: true },
      update: { isBlind: true },
      select: { filmId: true, isBlind: true, updatedAt: true },
    })
  })
})
