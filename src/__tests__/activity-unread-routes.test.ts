import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { update: vi.fn() },
  },
  apiLogger: { error: vi.fn() },
  getMobileOrServerSession: vi.fn(),
  hasUnreadIncoming: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))
vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/activity-feed', () => ({ hasUnreadIncoming: mocks.hasUnreadIncoming }))

const USER_ID = 'u1'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
})

describe('GET /api/activity/unread', () => {
  it('rejects unauthenticated requests with 401', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue(null)
    const { GET } = await import('@/app/api/activity/unread/route')
    const res = await GET()
    expect(res.status).toBe(401)
    expect(mocks.hasUnreadIncoming).not.toHaveBeenCalled()
  })

  it('returns { unread: true } when the data layer reports unread activity', async () => {
    mocks.hasUnreadIncoming.mockResolvedValue(true)
    const { GET } = await import('@/app/api/activity/unread/route')
    const res = await GET()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ unread: true })
    expect(mocks.hasUnreadIncoming).toHaveBeenCalledWith(USER_ID)
  })

  it('returns { unread: false } when nothing is unread', async () => {
    mocks.hasUnreadIncoming.mockResolvedValue(false)
    const { GET } = await import('@/app/api/activity/unread/route')
    const res = await GET()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ unread: false })
  })

  it('returns 500 when the data layer throws', async () => {
    mocks.hasUnreadIncoming.mockRejectedValue(new Error('db down'))
    const { GET } = await import('@/app/api/activity/unread/route')
    const res = await GET()
    expect(res.status).toBe(500)
    expect(mocks.apiLogger.error).toHaveBeenCalled()
  })
})

describe('POST /api/activity/seen', () => {
  it('rejects unauthenticated requests with 401', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue(null)
    const { POST } = await import('@/app/api/activity/seen/route')
    const res = await POST()
    expect(res.status).toBe(401)
    expect(mocks.prisma.user.update).not.toHaveBeenCalled()
  })

  it('sets lastSeenActivityAt to the current time and returns { ok: true }', async () => {
    mocks.prisma.user.update.mockResolvedValue({ id: USER_ID })
    const before = Date.now()
    const { POST } = await import('@/app/api/activity/seen/route')
    const res = await POST()
    const after = Date.now()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(mocks.prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { lastSeenActivityAt: expect.any(Date) },
      select: { id: true },
    })
    const call = mocks.prisma.user.update.mock.calls[0][0] as {
      data: { lastSeenActivityAt: Date }
    }
    const stamped = call.data.lastSeenActivityAt.getTime()
    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(after)
  })

  it('returns 500 when the update fails', async () => {
    mocks.prisma.user.update.mockRejectedValue(new Error('db down'))
    const { POST } = await import('@/app/api/activity/seen/route')
    const res = await POST()
    expect(res.status).toBe(500)
    expect(mocks.apiLogger.error).toHaveBeenCalled()
  })
})
