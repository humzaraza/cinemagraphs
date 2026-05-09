import { NextRequest, NextResponse } from 'next/server'
import { verifyAndRotateRefreshToken } from '@/lib/mobile-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { apiLogger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown'

    const { limited } = checkRateLimit('mobile-refresh', ip, 30, 15 * 60 * 1000)
    if (limited) {
      return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 })
    }

    const { refreshToken } = await request.json()
    if (!refreshToken || typeof refreshToken !== 'string') {
      return NextResponse.json({ error: 'Refresh token is required' }, { status: 400 })
    }

    const result = await verifyAndRotateRefreshToken(refreshToken)
    if (!result) {
      return NextResponse.json({ error: 'Invalid or expired refresh token' }, { status: 401 })
    }

    return NextResponse.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        image: result.user.picture,
        role: result.user.role,
      },
    })
  } catch (err) {
    apiLogger.error({ err }, 'Refresh token rotation failed')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
