import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-nextauth-createuser'
  process.env.GOOGLE_CLIENT_ID = 'test-google-id'
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret'
  process.env.APPLE_ID = 'test-apple-id'
  process.env.APPLE_SECRET = 'test-apple-secret'
})

// ---- prisma mock ----
const mockUserUpdate = vi.fn()
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      update: (...args: unknown[]) => mockUserUpdate(...args),
      findUnique: vi.fn(),
    },
    account: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}))

// ---- logger mock ----
vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { authOptions } from '@/lib/auth'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('NextAuth events.createUser', () => {
  it('is registered on authOptions.events', () => {
    expect(authOptions.events?.createUser).toBeDefined()
    expect(typeof authOptions.events?.createUser).toBe('function')
  })

  it('calls prisma.user.update with termsAcceptedAt (Date) and termsVersion 2026-05-15', async () => {
    const createUser = authOptions.events!.createUser!

    await createUser({
      user: {
        id: 'test-user-id',
        email: 'oauth@example.com',
        emailVerified: null,
      } as never,
    })

    expect(mockUserUpdate).toHaveBeenCalledTimes(1)
    const arg = mockUserUpdate.mock.calls[0][0] as {
      where: { id: string }
      data: Record<string, unknown>
    }
    expect(arg.where).toEqual({ id: 'test-user-id' })
    expect(arg.data.termsAcceptedAt).toBeInstanceOf(Date)
    expect(arg.data.termsVersion).toBe('2026-05-15')
  })
})
