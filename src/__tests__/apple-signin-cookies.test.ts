import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-apple-cookies'
  process.env.GOOGLE_CLIENT_ID = 'test-google-id'
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret'
  process.env.APPLE_ID = 'test-apple-id'
  process.env.APPLE_SECRET = 'test-apple-secret'
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { update: vi.fn(), findUnique: vi.fn() },
    account: { create: vi.fn(), findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { authOptions } from '@/lib/auth'

/**
 * Regression guard for the Sign in with Apple outage.
 *
 * Apple uses response_mode=form_post: appleid.apple.com auto-submits an
 * HTML form that POSTs cross-site to /api/auth/callback/apple. Browsers
 * send SameSite=Lax cookies only on top-level navigations using safe
 * methods, so on that POST a Lax state/nonce/PKCE cookie is withheld and
 * NextAuth throws OAuthCallbackError — an endless bounce back to the
 * sign-in page. Google is unaffected (response_mode=query is a GET).
 *
 * f8f3c1a (2026-03-28) set these to 'none' to fix that. 6c55529
 * (2026-05-10, "auth hardening") flipped them back to 'lax' and silently
 * re-broke Apple sign-in for three months, because nothing asserted it.
 * This test is that assertion.
 */
describe('NextAuth cookie SameSite policy (Sign in with Apple)', () => {
  const crossSiteCookies = ['pkceCodeVerifier', 'state', 'nonce', 'callbackUrl'] as const

  it.each(crossSiteCookies)(
    'keeps sameSite=none on the %s cookie so it survives Apple form_post',
    (key) => {
      const cookie = authOptions.cookies?.[key]
      expect(cookie, `authOptions.cookies.${key} is not configured`).toBeDefined()
      expect(cookie!.options?.sameSite).toBe('none')
    },
  )

  it.each(crossSiteCookies)('keeps secure=true on the %s cookie', (key) => {
    // SameSite=None is rejected by browsers unless Secure is also set, so
    // these two attributes have to move together.
    expect(authOptions.cookies?.[key]?.options?.secure).toBe(true)
  })

  it('scopes the csrfToken cookie to sameSite=lax', () => {
    // Deliberately NOT 'none'. NextAuth v4 validates CSRF only on same-site
    // POSTs to /api/auth/signin/:provider and /signout, never on the OAuth
    // callback, so this cookie never needs to travel cross-site.
    expect(authOptions.cookies?.csrfToken?.options?.sameSite).toBe('lax')
  })

  it('registers the apple provider', () => {
    const ids = authOptions.providers.map((p) => p.id)
    expect(ids).toContain('apple')
  })
})
