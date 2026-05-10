import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-apple-route'
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
// The route imports `appleSignin` as the default export and calls
// `appleSignin.verifyIdToken(token, { audience })`. The mock invokes the real
// audience-matching logic so the test can assert the route accepts a token
// whose aud is the iOS bundle ID.
const { mockVerifyIdToken } = vi.hoisted(() => ({
  mockVerifyIdToken: vi.fn(),
}))
vi.mock('apple-signin-auth', () => ({
  default: {
    verifyIdToken: mockVerifyIdToken,
  },
}))

// ---- logger mock ----
vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import { POST as applePOST } from '@/app/api/auth/mobile/apple/route'

function buildRequest(body: object): NextRequest {
  return new NextRequest('http://localhost/api/auth/mobile/apple', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckRateLimit.mockResolvedValue({ limited: false, remaining: 5, retryAfterMs: 0 })
})

describe('POST /api/auth/mobile/apple', () => {
  it('accepts id_token with iOS bundle ID audience', async () => {
    // Simulate the inbound token having aud=ca.cinemagraphs.app (iOS bundle).
    // The route should pass an audience array containing both the bundle ID
    // and the web Services ID, so this token verifies successfully.
    mockVerifyIdToken.mockImplementation(
      async (_token: string, opts: { audience: string | string[] }) => {
        const accepted = Array.isArray(opts.audience) ? opts.audience : [opts.audience]
        if (!accepted.includes('ca.cinemagraphs.app')) {
          throw new Error('jwt audience invalid. expected: ' + accepted.join(','))
        }
        return {
          email: 'mobileuser@example.com',
          sub: 'apple-sub-mobile-1',
          aud: 'ca.cinemagraphs.app',
        }
      }
    )
    mockFindUserByAnyEmail.mockResolvedValue(null)
    mockUserCreate.mockResolvedValue({
      id: 'u-mobile-1',
      email: 'mobileuser@example.com',
      name: 'mobileuser',
      image: null,
      role: 'USER',
    })
    mockAccountFindFirst.mockResolvedValue(null)
    mockAccountCreate.mockResolvedValue({})
    mockSignAccessToken.mockReturnValue('access-token-value')
    mockIssueRefreshToken.mockResolvedValue('refresh-token-value')

    const res = await applePOST(buildRequest({ identityToken: 'fake-apple-token' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.accessToken).toBe('access-token-value')
    expect(body.refreshToken).toBe('refresh-token-value')
    expect(body.user.email).toBe('mobileuser@example.com')

    // Confirm the route passed both audiences to verifyIdToken.
    expect(mockVerifyIdToken).toHaveBeenCalledTimes(1)
    const verifyCall = mockVerifyIdToken.mock.calls[0]
    const audienceArg = (verifyCall[1] as { audience: string | string[] }).audience
    expect(Array.isArray(audienceArg)).toBe(true)
    expect(audienceArg).toContain('ca.cinemagraphs.app')
    expect(audienceArg).toContain('ca.cinemagraphs.web')

    expect(mockSignAccessToken).toHaveBeenCalledTimes(1)
    expect(mockIssueRefreshToken).toHaveBeenCalledWith('u-mobile-1')
  })
})
