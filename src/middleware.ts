import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit } from './lib/rate-limit'

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

export async function middleware(request: NextRequest) {
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
      const { limited, retryAfterMs } = await checkRateLimit(
        'public-api',
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
      const { limited, retryAfterMs } = await checkRateLimit(
        'signin',
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
      const { limited, retryAfterMs } = await checkRateLimit(
        'account-creation',
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
