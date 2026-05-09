import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hashRefreshToken, revokeRefreshTokenFamily } from '@/lib/mobile-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { apiLogger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown'

    const { limited } = await checkRateLimit('mobile-logout', ip, 20, 15 * 60 * 1000)
    if (limited) {
      return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 })
    }

    const { refreshToken } = await request.json()
    if (!refreshToken || typeof refreshToken !== 'string') {
      return NextResponse.json({ message: 'Logged out' })
    }

    const tokenHash = hashRefreshToken(refreshToken)
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { family: true, userId: true },
    })

    if (stored) {
      await revokeRefreshTokenFamily(stored.family)
      apiLogger.debug({ family: stored.family }, 'User signed out, family revoked')
    }

    return NextResponse.json({ message: 'Logged out' })
  } catch (err) {
    apiLogger.error({ err }, 'Logout failed')
    return NextResponse.json({ message: 'Logged out' })
  }
}
