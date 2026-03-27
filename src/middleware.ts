import { NextRequest, NextResponse } from 'next/server'

/**
 * In-memory rate limiter for edge middleware.
 * Separate from the Node.js rate limiter since middleware runs in the edge runtime.
 */
const signInAttempts = new Map<string, number[]>()
const accountCreations = new Map<string, number[]>()

function isRateLimited(
  store: Map<string, number[]>,
  key: string,
  maxRequests: number,
  windowMs: number
): { limited: boolean; retryAfterMs: number } {
  const now = Date.now()
  const windowStart = now - windowMs

  let timestamps = store.get(key) || []
  timestamps = timestamps.filter((t) => t > windowStart)

  if (timestamps.length >= maxRequests) {
    const retryAfterMs = timestamps[0] + windowMs - now
    store.set(key, timestamps)
    return { limited: true, retryAfterMs }
  }

  timestamps.push(now)
  store.set(key, timestamps)
  return { limited: false, retryAfterMs: 0 }
}

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  )
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const ip = getClientIp(request)

  // Rate limit sign-in attempts: 10 per IP per 15 minutes
  if (pathname.startsWith('/api/auth/signin') || pathname.startsWith('/api/auth/callback')) {
    const { limited, retryAfterMs } = isRateLimited(
      signInAttempts,
      ip,
      10,
      15 * 60 * 1000 // 15 minutes
    )

    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts, please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': Math.ceil(retryAfterMs / 1000).toString() },
        }
      )
    }
  }

  // Rate limit account creation: 3 per IP per hour
  // NextAuth creates accounts on first callback, so we track callback/google specifically
  if (pathname.startsWith('/api/auth/callback/google')) {
    const { limited, retryAfterMs } = isRateLimited(
      accountCreations,
      ip,
      3,
      60 * 60 * 1000 // 1 hour
    )

    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts, please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': Math.ceil(retryAfterMs / 1000).toString() },
        }
      )
    }
  }

  // Honeypot check: if the request has a honeypot field in query params, reject silently
  if (pathname.startsWith('/api/auth/')) {
    const honeypot = request.nextUrl.searchParams.get('_hp_website')
    if (honeypot) {
      // Silently return a fake success — don't reveal detection
      return NextResponse.json({ url: '/' })
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/api/auth/:path*'],
}
