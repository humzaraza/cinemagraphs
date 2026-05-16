import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-register-terms'
})

// ---- prisma mocks ----
const mockUserFindUnique = vi.fn()
const mockUserCreate = vi.fn()
const mockUserUpdate = vi.fn()
const mockUserDelete = vi.fn()
const mockVerifTokenDeleteMany = vi.fn()
const mockVerifTokenCreate = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
      create: (...args: unknown[]) => mockUserCreate(...args),
      update: (...args: unknown[]) => mockUserUpdate(...args),
      delete: (...args: unknown[]) => mockUserDelete(...args),
    },
    verificationToken: {
      deleteMany: (...args: unknown[]) => mockVerifTokenDeleteMany(...args),
      create: (...args: unknown[]) => mockVerifTokenCreate(...args),
    },
  },
}))

// ---- email mock ----
const mockSendVerificationOTP = vi.fn()
vi.mock('@/lib/email', () => ({
  sendVerificationOTP: (...args: unknown[]) => mockSendVerificationOTP(...args),
  sendPasswordResetEmail: vi.fn(),
}))

// ---- bcrypt mock ----
const mockBcryptHash = vi.fn()
vi.mock('bcrypt', () => ({
  default: {
    hash: (...args: unknown[]) => mockBcryptHash(...args),
    compare: vi.fn(),
  },
}))

// ---- rate-limit mock ----
const mockCheckRateLimit = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

// ---- logger mock ----
vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import { POST as registerPOST } from '@/app/api/auth/register/route'

function buildRequest(body: object): NextRequest {
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckRateLimit.mockResolvedValue({ limited: false, remaining: 5, retryAfterMs: 0 })
  mockBcryptHash.mockResolvedValue('hashed-password')
  mockVerifTokenDeleteMany.mockResolvedValue({ count: 0 })
  mockVerifTokenCreate.mockResolvedValue({})
  mockSendVerificationOTP.mockResolvedValue(undefined)
})

describe('POST /api/auth/register: terms acceptance validation', () => {
  it('returns 400 when termsAccepted is missing on the new-user path', async () => {
    mockUserFindUnique.mockResolvedValue(null)

    const res = await registerPOST(
      buildRequest({ email: 'new@example.com', password: 'longenoughpw' })
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Terms acceptance required')
    expect(mockUserCreate).not.toHaveBeenCalled()
    expect(mockSendVerificationOTP).not.toHaveBeenCalled()
  })

  it('returns 400 when termsAccepted is false', async () => {
    mockUserFindUnique.mockResolvedValue(null)

    const res = await registerPOST(
      buildRequest({
        email: 'new@example.com',
        password: 'longenoughpw',
        termsAccepted: false,
        termsVersion: '2026-05-15',
      })
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Terms acceptance required')
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when termsVersion is missing while termsAccepted is true', async () => {
    mockUserFindUnique.mockResolvedValue(null)

    const res = await registerPOST(
      buildRequest({
        email: 'new@example.com',
        password: 'longenoughpw',
        termsAccepted: true,
      })
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Terms acceptance required')
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when termsVersion is an empty string', async () => {
    mockUserFindUnique.mockResolvedValue(null)

    const res = await registerPOST(
      buildRequest({
        email: 'new@example.com',
        password: 'longenoughpw',
        termsAccepted: true,
        termsVersion: '',
      })
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Terms acceptance required')
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  it('Case B: new user with valid terms body — 201 and create stamps termsAcceptedAt + termsVersion', async () => {
    mockUserFindUnique.mockResolvedValue(null)
    mockUserCreate.mockResolvedValue({ id: 'u-new' })

    const res = await registerPOST(
      buildRequest({
        email: 'new@example.com',
        password: 'longenoughpw',
        name: 'New User',
        termsAccepted: true,
        termsVersion: '2026-05-15',
      })
    )

    expect(res.status).toBe(201)
    expect(mockUserCreate).toHaveBeenCalledTimes(1)
    const createArg = mockUserCreate.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(createArg.data.email).toBe('new@example.com')
    expect(createArg.data.termsVersion).toBe('2026-05-15')
    expect(createArg.data.termsAcceptedAt).toBeInstanceOf(Date)
    expect(mockUserUpdate).not.toHaveBeenCalled()
    expect(mockUserDelete).not.toHaveBeenCalled()
  })

  it('Case C: OAuth-only user adding password — no terms required, update payload has no terms fields', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: 'u-oauth',
      password: null,
      emailVerified: new Date(),
    })
    mockUserUpdate.mockResolvedValue({ id: 'u-oauth' })

    const res = await registerPOST(
      buildRequest({
        email: 'oauth@example.com',
        password: 'longenoughpw',
        name: 'OAuth User',
      })
    )

    expect(res.status).toBe(201)
    expect(mockUserUpdate).toHaveBeenCalledTimes(1)
    const updateArg = mockUserUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(updateArg.data.termsAcceptedAt).toBeUndefined()
    expect(updateArg.data.termsVersion).toBeUndefined()
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  it('Case A: verified existing user with password — 409 with no prisma writes', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: 'u-existing',
      password: 'hashed',
      emailVerified: new Date(),
    })

    const res = await registerPOST(
      buildRequest({
        email: 'existing@example.com',
        password: 'longenoughpw',
      })
    )

    expect(res.status).toBe(409)
    expect(mockUserCreate).not.toHaveBeenCalled()
    expect(mockUserUpdate).not.toHaveBeenCalled()
    expect(mockUserDelete).not.toHaveBeenCalled()
  })

  it('Case D: unverified user with password and valid terms body — delete then create with terms fields', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: 'u-unverified',
      password: 'old-hashed',
      emailVerified: null,
    })
    mockUserDelete.mockResolvedValue({})
    mockUserCreate.mockResolvedValue({ id: 'u-new' })

    const res = await registerPOST(
      buildRequest({
        email: 'unverified@example.com',
        password: 'longenoughpw',
        termsAccepted: true,
        termsVersion: '2026-05-15',
      })
    )

    expect(res.status).toBe(201)
    expect(mockUserDelete).toHaveBeenCalledWith({ where: { id: 'u-unverified' } })
    expect(mockUserCreate).toHaveBeenCalledTimes(1)
    const createArg = mockUserCreate.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(createArg.data.termsVersion).toBe('2026-05-15')
    expect(createArg.data.termsAcceptedAt).toBeInstanceOf(Date)

    // Delete must run before create to avoid the unique-email collision.
    const deleteOrder = mockUserDelete.mock.invocationCallOrder[0]
    const createOrder = mockUserCreate.mock.invocationCallOrder[0]
    expect(deleteOrder).toBeLessThan(createOrder)
  })
})
