import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-mobile-oauth-terms'
})

// ---- prisma mocks ----
const mockUserCreate = vi.fn()
const mockUserUpdate = vi.fn()
const mockAccountFindFirst = vi.fn()
const mockAccountCreate = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      create: (...args: unknown[]) => mockUserCreate(...args),
      update: (...args: unknown[]) => mockUserUpdate(...args),
    },
    account: {
      findFirst: (...args: unknown[]) => mockAccountFindFirst(...args),
      create: (...args: unknown[]) => mockAccountCreate(...args),
    },
  },
}))

// ---- mobile-auth mocks ----
const mockSignAccessToken = vi.fn()
const mockIssueRefreshToken = vi.fn()
vi.mock('@/lib/mobile-auth', () => ({
  signAccessToken: (...args: unknown[]) => mockSignAccessToken(...args),
  issueRefreshToken: (...args: unknown[]) => mockIssueRefreshToken(...args),
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

// ---- apple-signin-auth mock ----
const { mockAppleVerifyIdToken } = vi.hoisted(() => ({
  mockAppleVerifyIdToken: vi.fn(),
}))
vi.mock('apple-signin-auth', () => ({
  default: {
    verifyIdToken: mockAppleVerifyIdToken,
  },
}))

// ---- google-auth-library mock ----
// google/route.ts constructs `new OAuth2Client(...)` at module load, so the
// mock class must be in place before the import below runs.
const { mockGoogleVerifyIdToken } = vi.hoisted(() => ({
  mockGoogleVerifyIdToken: vi.fn(),
}))
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = mockGoogleVerifyIdToken
  },
}))

// ---- logger mock ----
vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import { POST as applePOST } from '@/app/api/auth/mobile/apple/route'
import { POST as googlePOST } from '@/app/api/auth/mobile/google/route'

function buildRequest(path: string, body: object): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckRateLimit.mockResolvedValue({ limited: false, remaining: 5, retryAfterMs: 0 })
  mockSignAccessToken.mockReturnValue('access-token-value')
  mockIssueRefreshToken.mockResolvedValue('refresh-token-value')
  mockAccountFindFirst.mockResolvedValue(null)
  mockAccountCreate.mockResolvedValue({})
})

describe('POST /api/auth/mobile/apple: terms acceptance', () => {
  beforeEach(() => {
    mockAppleVerifyIdToken.mockResolvedValue({
      email: 'newapple@example.com',
      sub: 'apple-sub-1',
      aud: 'ca.cinemagraphs.app',
    })
  })

  it('returns 400 when a new user submits without termsAccepted', async () => {
    mockFindUserByAnyEmail.mockResolvedValue(null)

    const res = await applePOST(
      buildRequest('/api/auth/mobile/apple', { identityToken: 'fake-token' })
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Terms acceptance required')
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  it('returns 200 and stamps terms fields when a new user submits a valid terms body', async () => {
    mockFindUserByAnyEmail.mockResolvedValue(null)
    mockUserCreate.mockResolvedValue({
      id: 'u-apple-new',
      email: 'newapple@example.com',
      name: 'newapple',
      image: null,
      role: 'USER',
    })

    const res = await applePOST(
      buildRequest('/api/auth/mobile/apple', {
        identityToken: 'fake-token',
        termsAccepted: true,
        termsVersion: '2026-05-15',
      })
    )

    expect(res.status).toBe(200)
    expect(mockUserCreate).toHaveBeenCalledTimes(1)
    const createArg = mockUserCreate.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(createArg.data.termsVersion).toBe('2026-05-15')
    expect(createArg.data.termsAcceptedAt).toBeInstanceOf(Date)
  })

  it('existing-user sign-in proceeds without terms validation and does not call prisma.user.create', async () => {
    mockFindUserByAnyEmail.mockResolvedValue({
      id: 'u-existing',
      email: 'newapple@example.com',
      name: 'Existing',
      image: null,
      role: 'USER',
    })

    const res = await applePOST(
      buildRequest('/api/auth/mobile/apple', { identityToken: 'fake-token' })
    )

    expect(res.status).toBe(200)
    expect(mockUserCreate).not.toHaveBeenCalled()
  })
})

describe('POST /api/auth/mobile/google: terms acceptance', () => {
  beforeEach(() => {
    mockGoogleVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: 'newgoogle@example.com',
        email_verified: true,
        sub: 'google-sub-1',
        name: 'New Google',
        picture: null,
      }),
    })
  })

  it('returns 400 when a new user submits without termsAccepted', async () => {
    mockFindUserByAnyEmail.mockResolvedValue(null)

    const res = await googlePOST(
      buildRequest('/api/auth/mobile/google', { idToken: 'fake-token' })
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Terms acceptance required')
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  it('returns 200 and stamps terms fields when a new user submits a valid terms body', async () => {
    mockFindUserByAnyEmail.mockResolvedValue(null)
    mockUserCreate.mockResolvedValue({
      id: 'u-google-new',
      email: 'newgoogle@example.com',
      name: 'New Google',
      image: null,
      role: 'USER',
    })

    const res = await googlePOST(
      buildRequest('/api/auth/mobile/google', {
        idToken: 'fake-token',
        termsAccepted: true,
        termsVersion: '2026-05-15',
      })
    )

    expect(res.status).toBe(200)
    expect(mockUserCreate).toHaveBeenCalledTimes(1)
    const createArg = mockUserCreate.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(createArg.data.termsVersion).toBe('2026-05-15')
    expect(createArg.data.termsAcceptedAt).toBeInstanceOf(Date)
  })

  it('existing-user sign-in proceeds without terms validation and does not call prisma.user.create', async () => {
    mockFindUserByAnyEmail.mockResolvedValue({
      id: 'u-existing',
      email: 'newgoogle@example.com',
      name: 'Existing',
      image: null,
      role: 'USER',
    })

    const res = await googlePOST(
      buildRequest('/api/auth/mobile/google', { idToken: 'fake-token' })
    )

    expect(res.status).toBe(200)
    expect(mockUserCreate).not.toHaveBeenCalled()
  })
})
