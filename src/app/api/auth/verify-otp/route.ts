import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { signAccessToken, issueRefreshToken } from '@/lib/mobile-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { apiLogger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown'

    const { limited } = checkRateLimit('verify-otp', ip, 10, 15 * 60 * 1000)
    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      )
    }

    const body = await request.json()
    const { email, code, mobile } = body

    if (!email || !code) {
      return NextResponse.json({ error: 'Email and code are required' }, { status: 400 })
    }

    const emailLower = email.toLowerCase().trim()

    // Look up the active token for this identifier (regardless of code value).
    // Tracking attempts requires finding the active token even when the user
    // submits the wrong code.
    const activeToken = await prisma.verificationToken.findFirst({
      where: { identifier: emailLower, expires: { gt: new Date() } },
    })

    if (!activeToken) {
      return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400 })
    }

    if (activeToken.token !== code) {
      const newAttempts = activeToken.attempts + 1

      if (newAttempts >= 5) {
        // Too many wrong codes. Invalidate the token; user must request a new one.
        await prisma.verificationToken.deleteMany({ where: { identifier: emailLower } })
        return NextResponse.json(
          { error: 'Too many invalid attempts. Please request a new code.' },
          { status: 400 }
        )
      }

      await prisma.verificationToken.update({
        where: { token: activeToken.token },
        data: { attempts: newAttempts },
      })

      return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400 })
    }

    // Mark user as verified
    const verifiedUser = await prisma.user.update({
      where: { email: emailLower },
      data: { emailVerified: new Date() },
      select: { id: true, email: true, name: true, image: true, role: true },
    })

    // Clean up token
    await prisma.verificationToken.deleteMany({
      where: { identifier: emailLower },
    })

    // For mobile clients, return a JWT so the user is logged in immediately
    if (mobile) {
      const accessToken = signAccessToken({
        id: verifiedUser.id,
        email: verifiedUser.email,
        name: verifiedUser.name,
        role: verifiedUser.role,
        picture: verifiedUser.image,
      })
      const refreshToken = await issueRefreshToken(verifiedUser.id)

      return NextResponse.json({
        message: 'Email verified successfully',
        accessToken,
        refreshToken,
        user: {
          id: verifiedUser.id,
          email: verifiedUser.email,
          name: verifiedUser.name,
          image: verifiedUser.image,
          role: verifiedUser.role,
        },
      })
    }

    return NextResponse.json({ message: 'Email verified successfully' })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to verify OTP')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
