import { headers } from 'next/headers'
import { getServerSession } from 'next-auth'
import jwt from 'jsonwebtoken'
import { randomBytes, createHash } from 'crypto'
import { authOptions } from './auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

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
    return null
  }

  const token = authHeader.slice(7)
  try {
    const payload = jwt.verify(token, JWT_SECRET) as MobileTokenPayload
    if (!payload.id) {
      apiLogger.warn({}, 'Mobile token payload missing id')
      return null
    }
    return payload
  } catch (err) {
    apiLogger.debug(
      { errorName: err instanceof Error ? err.name : 'unknown' },
      'Mobile token verification failed',
    )
    return null
  }
}

const ACCESS_TOKEN_EXPIRY = '15m'
const REFRESH_TOKEN_TTL_DAYS = 30

export function signAccessToken(payload: MobileTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY })
}

export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

/**
 * Issues a new refresh token for the given user. Creates a new family
 * (one family per device login session). Returns the raw token to be
 * sent to the client; only the hash is persisted.
 */
export async function issueRefreshToken(userId: string): Promise<string> {
  const rawToken = randomBytes(32).toString('hex')
  const tokenHash = hashRefreshToken(rawToken)
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)

  // First token in a family uses its own id as the family. New tokens
  // rotated from this one inherit the same family value.
  const created = await prisma.refreshToken.create({
    data: {
      userId,
      family: 'pending',
      tokenHash,
      expiresAt,
    },
  })
  await prisma.refreshToken.update({
    where: { id: created.id },
    data: { family: created.id },
  })

  return rawToken
}

interface RotationResult {
  accessToken: string
  refreshToken: string
  user: MobileTokenPayload
}

/**
 * Validates a refresh token and rotates it. On success, returns a new
 * access + refresh pair. On replay detection (caller presents an
 * already-rotated token), revokes the entire family and returns null.
 * On any other failure (expired, revoked, not found), returns null.
 */
export async function verifyAndRotateRefreshToken(rawToken: string): Promise<RotationResult | null> {
  const tokenHash = hashRefreshToken(rawToken)

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true, name: true, role: true, image: true } } },
  })

  if (!stored) {
    return null
  }

  // Replay detection: this token was already rotated. Revoke the family.
  if (stored.replacedById !== null) {
    apiLogger.warn(
      { userId: stored.userId, family: stored.family },
      'Refresh token replay detected; revoking family'
    )
    await revokeRefreshTokenFamily(stored.family)
    return null
  }

  if (stored.revokedAt !== null) {
    return null
  }

  if (stored.expiresAt < new Date()) {
    return null
  }

  const newRawToken = randomBytes(32).toString('hex')
  const newTokenHash = hashRefreshToken(newRawToken)
  const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)

  const newToken = await prisma.refreshToken.create({
    data: {
      userId: stored.userId,
      family: stored.family,
      tokenHash: newTokenHash,
      expiresAt: newExpiresAt,
    },
  })

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: {
      replacedById: newToken.id,
      revokedAt: new Date(),
    },
  })

  const payload: MobileTokenPayload = {
    id: stored.user.id,
    email: stored.user.email,
    name: stored.user.name,
    role: stored.user.role,
    picture: stored.user.image,
  }

  return {
    accessToken: signAccessToken(payload),
    refreshToken: newRawToken,
    user: payload,
  }
}

/**
 * Revokes all tokens in a family. Used on logout (per-device sign-out)
 * and on replay detection.
 */
export async function revokeRefreshTokenFamily(family: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { family, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/**
 * Try cookie-based session first (web), then fall back to Bearer token (mobile).
 * Returns a normalized session-like object or null.
 */
export async function getMobileOrServerSession() {
  // 1. Try web cookie session via NextAuth
  const session = await getServerSession(authOptions)
  if (session?.user?.id) {
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

  // 2. Fall back to mobile Bearer token
  const mobilePayload = await verifyMobileToken()
  if (mobilePayload) {
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

  return null
}
