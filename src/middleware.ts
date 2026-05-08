import { NextRequest, NextResponse } from 'next/server'

/**
 * In-memory rate limiter for edge middleware.
 * Separate from the Node.js rate limiter since middleware runs in the edge runtime.
 */
const signInAttempts = new Map<string, number[]>()
const accountCreations = new Map<string, number[]>()
const publicApiRequests = new Map<string, number[]>()

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

const ALLOWED_ORIGINS = [
  'https://cinemagraphs.ca',
  'https://www.cinemagraphs.ca',
  'http://localhost:3000',
]

const BLOCKED_UA_PATTERN = /curl|python|scrapy|wget|bot/i

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const ip = getClientIp(request)

  // --- Block suspicious User-Agents on API routes (exempt auth callbacks
  // and onboarding, which runs pre-account on mobile) ---
  if (
    pathname.startsWith('/api/') &&
    !pathname.startsWith('/api/auth/') &&
    !pathname.startsWith('/api/onboarding/')
  ) {
    const ua = request.headers.get('user-agent') || ''
    if (!ua || BLOCKED_UA_PATTERN.test(ua)) {
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      )
    }
  }

  // --- CORS restriction on API routes (exempt auth callbacks and
  // onboarding, which runs pre-account on mobile) ---
  if (
    pathname.startsWith('/api/') &&
    !pathname.startsWith('/api/auth/') &&
    !pathname.startsWith('/api/onboarding/')
  ) {
    const origin = request.headers.get('origin')
    // If there's an Origin header (cross-origin request), validate it
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new NextResponse(null, {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
        statusText: 'Forbidden',
      })
    }

    // Set CORS headers on the response
    const response = NextResponse.next()
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin)
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    }

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new NextResponse(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : '',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    // --- Rate limit public API routes: 60 per IP per minute ---
    if (pathname.startsWith('/api/films')) {
      const { limited, retryAfterMs } = isRateLimited(
        publicApiRequests,
        ip,
        60,
        60 * 1000 // 1 minute
      )

      if (limited) {
        return NextResponse.json(
          { error: 'Too many requests. Please slow down.' },
          {
            status: 429,
            headers: { 'Retry-After': Math.ceil(retryAfterMs / 1000).toString() },
          }
        )
      }
    }

    // --- Auth-specific rate limiting ---

    // Rate limit sign-in attempts: 10 per IP per 15 minutes
    if (pathname.startsWith('/api/auth/signin') || pathname.startsWith('/api/auth/callback')) {
      const { limited, retryAfterMs } = isRateLimited(
        signInAttempts,
        ip,
        10,
        15 * 60 * 1000
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
    if (pathname.startsWith('/api/auth/callback/google')) {
      const { limited, retryAfterMs } = isRateLimited(
        accountCreations,
        ip,
        3,
        60 * 60 * 1000
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

    // Honeypot check
    if (pathname.startsWith('/api/auth/')) {
      const honeypot = request.nextUrl.searchParams.get('_hp_website')
      if (honeypot) {
        return NextResponse.json({ url: '/' })
      }
    }

    return response
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/api/:path*'],
}
