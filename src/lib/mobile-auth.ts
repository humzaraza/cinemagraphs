import { headers } from 'next/headers'
import { getServerSession } from 'next-auth'
import jwt from 'jsonwebtoken'
import { authOptions } from './auth'

export interface MobileTokenPayload {
  id: string
  email: string
  name: string | null
  role: string
  picture: string | null
}

const JWT_SECRET = process.env.NEXTAUTH_SECRET!

/**
 * Extract and verify a Bearer token from the Authorization header.
 * These are mobile-specific JWTs signed with jsonwebtoken -- completely
 * separate from NextAuth's JWE-encrypted session cookies.
 */
export async function verifyMobileToken(): Promise<MobileTokenPayload | null> {
  const headersList = await headers()
  const authHeader = headersList.get('authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    console.error('[mobile-auth] No Bearer token detected in Authorization header', {
      authHeaderPresent: !!authHeader,
      authHeaderPrefix: authHeader?.slice(0, 10) ?? null,
    })
    return null
  }

  console.error('[mobile-auth] Bearer token detected, attempting verification...')
  const token = authHeader.slice(7)
  try {
    const payload = jwt.verify(token, JWT_SECRET) as MobileTokenPayload
    if (!payload.id) {
      console.error('[mobile-auth] Token verified but payload has no id', { payload })
      return null
    }
    console.error('[mobile-auth] Token verification SUCCESS', {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      name: payload.name,
    })
    return payload
  } catch (err) {
    console.error('[mobile-auth] Token verification FAILED', {
      error: err instanceof Error ? err.message : 'Unknown error',
      name: err instanceof Error ? err.name : undefined,
    })
    return null
  }
}

/**
 * Sign a mobile JWT with a 30-day expiry.
 */
export function signMobileToken(payload: Omit<MobileTokenPayload, 'role'> & { role: string }): string {
  // TODO: v2: implement refresh token rotation. Users will be silently logged out after 30 days until this is built.
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' })
}

/**
 * Try cookie-based session first (web), then fall back to Bearer token (mobile).
 * Returns a normalized session-like object or null.
 */
export async function getMobileOrServerSession() {
  // 1. Try web cookie session via NextAuth
  const session = await getServerSession(authOptions)
  if (session?.user?.id) {
    console.error('[mobile-auth] Web cookie session found', { userId: session.user.id })
    return {
      user: {
        id: session.user.id,
        role: session.user.role || 'USER',
        name: session.user.name || null,
        email: session.user.email || null,
        image: session.user.image || null,
      },
    }
  }

  console.error('[mobile-auth] No web cookie session, trying Bearer token...')

  // 2. Fall back to mobile Bearer token
  const mobilePayload = await verifyMobileToken()
  if (mobilePayload) {
    console.error('[mobile-auth] Mobile auth resolved', { userId: mobilePayload.id })
    return {
      user: {
        id: mobilePayload.id,
        role: (mobilePayload.role as 'USER' | 'MODERATOR' | 'ADMIN' | 'BANNED') || 'USER',
        name: mobilePayload.name || null,
        email: mobilePayload.email || null,
        image: mobilePayload.picture || null,
      },
    }
  }

  console.error('[mobile-auth] Both auth methods failed — returning null')
  return null
}
