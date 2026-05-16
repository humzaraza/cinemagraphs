import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getMobileOrServerSession: vi.fn(),
  checkRateLimit: vi.fn(),
  deleteUserAndAllData: vi.fn(),
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/lib/mobile-auth', () => ({
  getMobileOrServerSession: mocks.getMobileOrServerSession,
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))
vi.mock('@/lib/user-deletion', () => ({
  deleteUserAndAllData: mocks.deleteUserAndAllData,
}))
vi.mock('@/lib/logger', () => ({
  apiLogger: mocks.apiLogger,
}))

const USER_ID = 'user_self_delete'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
  mocks.checkRateLimit.mockResolvedValue({ limited: false, remaining: 5, retryAfterMs: 0 })
  mocks.deleteUserAndAllData.mockResolvedValue(undefined)
})

describe('DELETE /api/user', () => {
  it('returns 401 and skips deletion when there is no session', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/user/route')
    const res = await DELETE()
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ error: 'Authentication required' })
    expect(mocks.deleteUserAndAllData).not.toHaveBeenCalled()
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
  })

  it('returns 429 and skips deletion when rate-limited', async () => {
    mocks.checkRateLimit.mockResolvedValue({ limited: true, remaining: 0, retryAfterMs: 1000 })
    const { DELETE } = await import('@/app/api/user/route')
    const res = await DELETE()
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body).toEqual({ error: 'Too many attempts. Please try again later.' })
    expect(mocks.deleteUserAndAllData).not.toHaveBeenCalled()
  })

  it('returns 200 with { message: "Account deleted" } and calls deleteUserAndAllData with session.user.id on success', async () => {
    const { DELETE } = await import('@/app/api/user/route')
    const res = await DELETE()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ message: 'Account deleted' })
    expect(mocks.deleteUserAndAllData).toHaveBeenCalledTimes(1)
    expect(mocks.deleteUserAndAllData).toHaveBeenCalledWith(USER_ID)
  })

  it('invokes checkRateLimit with ("account-delete", session.user.id, 5, 3_600_000)', async () => {
    const { DELETE } = await import('@/app/api/user/route')
    await DELETE()
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('account-delete', USER_ID, 5, 60 * 60 * 1000)
  })

  it('returns 500 with { error: "Failed to delete account" } and logs error with userId when deleteUserAndAllData throws', async () => {
    mocks.deleteUserAndAllData.mockRejectedValue(new Error('db blew up'))
    const { DELETE } = await import('@/app/api/user/route')
    const res = await DELETE()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'Failed to delete account' })
    expect(mocks.apiLogger.error).toHaveBeenCalledTimes(1)
    const [meta] = mocks.apiLogger.error.mock.calls[0]
    expect(meta).toMatchObject({ userId: USER_ID })
  })
})
