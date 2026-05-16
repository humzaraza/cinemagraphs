import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-auth-hardening'
})

// ---- prisma mocks ----
const mockUserFindUnique = vi.fn()
const mockUserCreate = vi.fn()
const mockUserUpdate = vi.fn()
const mockUserDelete = vi.fn()
const mockAccountFindFirst = vi.fn()
const mockAccountCreate = vi.fn()
const mockVerifTokenFindFirst = vi.fn()
const mockVerifTokenUpdate = vi.fn()
const mockVerifTokenDeleteMany = vi.fn()
const mockVerifTokenCreate = vi.fn()
const mockPasswordResetTokenDeleteMany = vi.fn()
const mockPasswordResetTokenCreate = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
      create: (...args: unknown[]) => mockUserCreate(...args),
      update: (...args: unknown[]) => mockUserUpdate(...args),
      delete: (...args: unknown[]) => mockUserDelete(...args),
    },
    account: {
      findFirst: (...args: unknown[]) => mockAccountFindFirst(...args),
      create: (...args: unknown[]) => mockAccountCreate(...args),
    },
    verificationToken: {
      findFirst: (...args: unknown[]) => mockVerifTokenFindFirst(...args),
      update: (...args: unknown[]) => mockVerifTokenUpdate(...args),
      deleteMany: (...args: unknown[]) => mockVerifTokenDeleteMany(...args),
      create: (...args: unknown[]) => mockVerifTokenCreate(...args),
    },
    passwordResetToken: {
      deleteMany: (...args: unknown[]) => mockPasswordResetTokenDeleteMany(...args),
      create: (...args: unknown[]) => mockPasswordResetTokenCreate(...args),
    },
  },
}))

// ---- mobile-auth mocks ----
const mockSignAccessToken = vi.fn()
const mockIssueRefreshToken = vi.fn()
const mockGetMobileOrServerSession = vi.fn()

vi.mock('@/lib/mobile-auth', () => ({
  signAccessToken: (...args: unknown[]) => mockSignAccessToken(...args),
  issueRefreshToken: (...args: unknown[]) => mockIssueRefreshToken(...args),
  getMobileOrServerSession: (...args: unknown[]) => mockGetMobileOrServerSession(...args),
}))

// ---- user-lookup mock ----
const mockFindUserByAnyEmail = vi.fn()
vi.mock('@/lib/user-lookup', () => ({
  findUserByAnyEmail: (...args: unknown[]) => mockFindUserByAnyEmail(...args),
}))

// ---- rate-limit mock ----
const mockCheckRateLimit = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

// ---- email mocks ----
const mockSendPasswordResetEmail = vi.fn()
const mockSendVerificationOTP = vi.fn()
vi.mock('@/lib/email', () => ({
  sendPasswordResetEmail: (...args: unknown[]) => mockSendPasswordResetEmail(...args),
  sendVerificationOTP: (...args: unknown[]) => mockSendVerificationOTP(...args),
}))

// ---- bcrypt mock ----
const mockBcryptHash = vi.fn()
const mockBcryptCompare = vi.fn()
vi.mock('bcrypt', () => ({
  default: {
    hash: (...args: unknown[]) => mockBcryptHash(...args),
    compare: (...args: unknown[]) => mockBcryptCompare(...args),
  },
}))

// ---- google-auth-library mock ----
// google/route.ts does `const googleClient = new OAuth2Client(...)` at module
// load, so the OAuth2Client constructor runs before any top-level test-file
// statements. vi.hoisted lifts mockVerifyIdToken alongside vi.mock so it is
// initialized before the constructor reads it.
const { mockVerifyIdToken } = vi.hoisted(() => ({
  mockVerifyIdToken: vi.fn(),
}))
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = mockVerifyIdToken
  },
}))

// ---- logger mock ----
vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

// Imports run after all the vi.mock() calls above are hoisted.
import { POST as googlePOST } from '@/app/api/auth/mobile/google/route'
import { POST as verifyOtpPOST } from '@/app/api/auth/verify-otp/route'
import { POST as changePasswordPOST } from '@/app/api/auth/change-password/route'
import { POST as forgotPasswordPOST } from '@/app/api/auth/forgot-password/route'
import { POST as registerPOST } from '@/app/api/auth/register/route'

function buildRequest(body: object): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let originalNextAuthUrl: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  // Default: rate limit allows the request through.
  // checkRateLimit is now async (Chunk 5), so resolve a Promise.
  mockCheckRateLimit.mockResolvedValue({ limited: false, remaining: 5, retryAfterMs: 0 })
  originalNextAuthUrl = process.env.NEXTAUTH_URL
})

afterEach(() => {
  if (originalNextAuthUrl === undefined) {
    delete process.env.NEXTAUTH_URL
  } else {
    process.env.NEXTAUTH_URL = originalNextAuthUrl
  }
})

// ---------------------------------------------------------------------------
// google route: email_verified check
// ---------------------------------------------------------------------------
describe('POST /api/auth/mobile/google', () => {
  it('returns 401 when payload.email_verified is not true', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'a@b.com', email_verified: false, sub: 'sub-1' }),
    })

    const res = await googlePOST(buildRequest({ idToken: 'fake-google-token' }))

    expect(res.status).toBe(401)
    expect(mockFindUserByAnyEmail).not.toHaveBeenCalled()
    expect(mockSignAccessToken).not.toHaveBeenCalled()
    expect(mockIssueRefreshToken).not.toHaveBeenCalled()
  })

  it('proceeds to token issuance when email_verified is true', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: 'a@b.com',
        email_verified: true,
        sub: 'sub-2',
        name: 'Alice',
        picture: null,
      }),
    })
    mockFindUserByAnyEmail.mockResolvedValue(null)
    mockUserCreate.mockResolvedValue({
      id: 'u-2',
      email: 'a@b.com',
      name: 'Alice',
      image: null,
      role: 'USER',
    })
    mockAccountFindFirst.mockResolvedValue(null)
    mockAccountCreate.mockResolvedValue({})
    mockSignAccessToken.mockReturnValue('access-token-value')
    mockIssueRefreshToken.mockResolvedValue('refresh-token-value')

    const res = await googlePOST(
      buildRequest({
        idToken: 'fake-google-token',
        termsAccepted: true,
        termsVersion: '2026-05-15',
      })
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.accessToken).toBe('access-token-value')
    expect(body.refreshToken).toBe('refresh-token-value')
    expect(mockSignAccessToken).toHaveBeenCalledTimes(1)
    expect(mockIssueRefreshToken).toHaveBeenCalledWith('u-2')
  })
})

// ---------------------------------------------------------------------------
// verify-otp: attempts tracking
// ---------------------------------------------------------------------------
describe('POST /api/auth/verify-otp', () => {
  it('wrong code with attempts < 4 increments attempts and returns 400', async () => {
    mockVerifTokenFindFirst.mockResolvedValue({
      identifier: 'a@b.com',
      token: '123456',
      expires: new Date(Date.now() + 60_000),
      attempts: 2,
    })
    mockVerifTokenUpdate.mockResolvedValue({})

    const res = await verifyOtpPOST(buildRequest({ email: 'a@b.com', code: '999999' }))

    expect(res.status).toBe(400)
    expect(mockVerifTokenUpdate).toHaveBeenCalledWith({
      where: { token: '123456' },
      data: { attempts: 3 },
    })
    expect(mockVerifTokenDeleteMany).not.toHaveBeenCalled()
  })

  it('wrong code on the 5th attempt deletes the token and returns the lockout message', async () => {
    mockVerifTokenFindFirst.mockResolvedValue({
      identifier: 'a@b.com',
      token: '123456',
      expires: new Date(Date.now() + 60_000),
      attempts: 4,
    })
    mockVerifTokenDeleteMany.mockResolvedValue({ count: 1 })

    const res = await verifyOtpPOST(buildRequest({ email: 'a@b.com', code: '999999' }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/Too many invalid attempts/i)
    expect(mockVerifTokenDeleteMany).toHaveBeenCalledWith({
      where: { identifier: 'a@b.com' },
    })
    expect(mockVerifTokenUpdate).not.toHaveBeenCalled()
  })

  it('correct code on the first attempt succeeds and deletes the token', async () => {
    mockVerifTokenFindFirst.mockResolvedValue({
      identifier: 'a@b.com',
      token: '123456',
      expires: new Date(Date.now() + 60_000),
      attempts: 0,
    })
    mockUserUpdate.mockResolvedValue({
      id: 'u-1',
      email: 'a@b.com',
      name: 'Alice',
      image: null,
      role: 'USER',
    })
    mockVerifTokenDeleteMany.mockResolvedValue({ count: 1 })

    const res = await verifyOtpPOST(buildRequest({ email: 'a@b.com', code: '123456' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.message).toMatch(/verified/i)
    expect(mockUserUpdate).toHaveBeenCalledTimes(1)
    expect(mockVerifTokenDeleteMany).toHaveBeenCalledWith({
      where: { identifier: 'a@b.com' },
    })
    expect(mockVerifTokenUpdate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// change-password: per-user rate limiting
// ---------------------------------------------------------------------------
describe('POST /api/auth/change-password', () => {
  it('returns 429 when checkRateLimit reports limited (the 6th attempt within an hour)', async () => {
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'u-1', role: 'USER', name: null, email: 'a@b.com', image: null },
    })
    mockCheckRateLimit.mockResolvedValue({ limited: true, remaining: 0, retryAfterMs: 60_000 })

    const res = await changePasswordPOST(
      buildRequest({ currentPassword: 'old-pass', newPassword: 'new-password-1' })
    )

    expect(res.status).toBe(429)
    expect(mockCheckRateLimit).toHaveBeenCalledWith('change-password', 'u-1', 5, 60 * 60 * 1000)
    expect(mockBcryptCompare).not.toHaveBeenCalled()
    expect(mockUserUpdate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// forgot-password: NEXTAUTH_URL handling
// ---------------------------------------------------------------------------
describe('POST /api/auth/forgot-password', () => {
  it('uses process.env.NEXTAUTH_URL when set', async () => {
    process.env.NEXTAUTH_URL = 'https://staging.example.com'
    mockFindUserByAnyEmail.mockResolvedValue({
      id: 'u-1',
      email: 'a@b.com',
      name: null,
      image: null,
      role: 'USER',
    })
    mockUserFindUnique.mockResolvedValue({ id: 'u-1', password: 'hashed' })
    mockPasswordResetTokenDeleteMany.mockResolvedValue({ count: 0 })
    mockPasswordResetTokenCreate.mockResolvedValue({})
    mockSendPasswordResetEmail.mockResolvedValue(undefined)

    const res = await forgotPasswordPOST(buildRequest({ email: 'a@b.com' }))

    expect(res.status).toBe(200)
    expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1)
    const url = mockSendPasswordResetEmail.mock.calls[0][1] as string
    expect(url).toMatch(/^https:\/\/staging\.example\.com\/auth\/reset-password\?token=/)
  })

  it('falls back to https://cinemagraphs.ca when NEXTAUTH_URL is unset', async () => {
    delete process.env.NEXTAUTH_URL
    mockFindUserByAnyEmail.mockResolvedValue({
      id: 'u-1',
      email: 'a@b.com',
      name: null,
      image: null,
      role: 'USER',
    })
    mockUserFindUnique.mockResolvedValue({ id: 'u-1', password: 'hashed' })
    mockPasswordResetTokenDeleteMany.mockResolvedValue({ count: 0 })
    mockPasswordResetTokenCreate.mockResolvedValue({})
    mockSendPasswordResetEmail.mockResolvedValue(undefined)

    const res = await forgotPasswordPOST(buildRequest({ email: 'a@b.com' }))

    expect(res.status).toBe(200)
    expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1)
    const url = mockSendPasswordResetEmail.mock.calls[0][1] as string
    expect(url).toMatch(/^https:\/\/cinemagraphs\.ca\/auth\/reset-password\?token=/)
  })
})

// ---------------------------------------------------------------------------
// register: case A (verified existing) and case D (unverified with password)
// ---------------------------------------------------------------------------
describe('POST /api/auth/register', () => {
  it('Case A: verified existing user with password returns 409', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: 'u-1',
      password: 'hashed',
      emailVerified: new Date(),
    })

    const res = await registerPOST(
      buildRequest({ email: 'a@b.com', password: 'longenoughpw' })
    )

    expect(res.status).toBe(409)
    expect(mockUserCreate).not.toHaveBeenCalled()
    expect(mockUserUpdate).not.toHaveBeenCalled()
    expect(mockUserDelete).not.toHaveBeenCalled()
    expect(mockSendVerificationOTP).not.toHaveBeenCalled()
  })

  it('Case D: unverified existing user with password deletes then recreates', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: 'u-1',
      password: 'old-hashed',
      emailVerified: null,
    })
    mockBcryptHash.mockResolvedValue('new-hashed-password')
    mockVerifTokenDeleteMany.mockResolvedValue({ count: 0 })
    mockUserDelete.mockResolvedValue({})
    mockUserCreate.mockResolvedValue({})
    mockVerifTokenCreate.mockResolvedValue({})
    mockSendVerificationOTP.mockResolvedValue(undefined)

    const res = await registerPOST(
      buildRequest({
        email: 'a@b.com',
        password: 'longenoughpw',
        name: 'Alice',
        termsAccepted: true,
        termsVersion: '2026-05-15',
      })
    )

    expect(res.status).toBe(201)
    expect(mockUserDelete).toHaveBeenCalledWith({ where: { id: 'u-1' } })
    expect(mockUserCreate).toHaveBeenCalledTimes(1)
    expect(mockUserUpdate).not.toHaveBeenCalled()

    // Delete must run before create to avoid the unique-email collision.
    const deleteOrder = mockUserDelete.mock.invocationCallOrder[0]
    const createOrder = mockUserCreate.mock.invocationCallOrder[0]
    expect(deleteOrder).toBeLessThan(createOrder)
  })
})
