import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Hoisted so the mock fn binding is initialized before vi.mock's factory
// closure captures it. Defensive: middleware.ts only calls checkRateLimit
// inside the exported function today, but hoisting protects against future
// module-load-time invocations.
const { mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}))

import { middleware } from '@/middleware'

beforeEach(() => {
  vi.clearAllMocks()
  // Default: every checkRateLimit call returns not-limited.
  mockCheckRateLimit.mockResolvedValue({ limited: false, remaining: 10, retryAfterMs: 0 })
})

function makeRequest(
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
): NextRequest {
  // Default User-Agent must avoid the BLOCKED_UA_PATTERN (curl|python|
  // scrapy|wget|bot) so requests routed through the general API guard
  // (e.g. /api/films) don't 403 before reaching the rate-limit check.
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      'x-forwarded-for': '1.2.3.4',
      'user-agent': 'Mozilla/5.0 (test)',
      ...(init?.headers ?? {}),
    },
  })
}

describe('middleware: lifted auth-specific protections', () => {
  it('triggers signin rate limit on /api/auth/signin and returns 429 with Retry-After when limited', async () => {
    // Sub-assertion 1: under limit, the right call is issued.
    await middleware(makeRequest('http://localhost/api/auth/signin'))
    expect(mockCheckRateLimit).toHaveBeenCalledWith('signin', '1.2.3.4', 10, 15 * 60 * 1000)

    // Sub-assertion 2: when limited, middleware responds 429 with Retry-After.
    mockCheckRateLimit.mockResolvedValueOnce({ limited: true, remaining: 0, retryAfterMs: 5000 })
    const res = await middleware(makeRequest('http://localhost/api/auth/signin'))
    expect(res?.status).toBe(429)
    expect(res?.headers.get('Retry-After')).toBe('5')
  })

  it('triggers account-creation rate limit on /api/auth/callback/google', async () => {
    await middleware(makeRequest('http://localhost/api/auth/callback/google'))

    // Path also matches /api/auth/callback so 'signin' fires first; both
    // calls should be present, and we specifically assert the new one.
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'account-creation',
      '1.2.3.4',
      3,
      60 * 60 * 1000,
    )
  })

  it('honeypot trap fires on /api/auth/* with _hp_website query', async () => {
    const res = await middleware(
      makeRequest('http://localhost/api/auth/anything?_hp_website=spam'),
    )

    expect(res?.status).toBe(200)
    const body = await res!.json()
    expect(body).toEqual({ url: '/' })
  })

  it('triggers public-api rate limit on /api/films (preserved behavior)', async () => {
    await middleware(makeRequest('http://localhost/api/films'))

    expect(mockCheckRateLimit).toHaveBeenCalledWith('public-api', '1.2.3.4', 60, 60 * 1000)
  })

  it('does NOT call checkRateLimit on /api/onboarding/* paths (bypass preserved)', async () => {
    await middleware(makeRequest('http://localhost/api/onboarding/select-banner'))

    expect(mockCheckRateLimit).not.toHaveBeenCalled()
  })
})
