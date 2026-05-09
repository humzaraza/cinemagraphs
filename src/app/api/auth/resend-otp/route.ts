import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sendVerificationOTP } from '@/lib/email'
import { checkRateLimit } from '@/lib/rate-limit'
import { apiLogger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown'

    const { limited } = await checkRateLimit('resend-otp', ip, 3, 5 * 60 * 1000)
    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please wait before requesting another code.' },
        { status: 429 }
      )
    }

    const { email } = await request.json()
    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const emailLower = email.toLowerCase().trim()

    // Verify user exists and is unverified
    const user = await prisma.user.findUnique({
      where: { email: emailLower },
      select: { emailVerified: true },
    })

    if (!user || user.emailVerified) {
      // Don't reveal account status
      return NextResponse.json({ message: 'If an account exists, a new code has been sent.' })
    }

    // Invalidate old tokens and create new OTP
    await prisma.verificationToken.deleteMany({
      where: { identifier: emailLower },
    })

    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const expires = new Date(Date.now() + 10 * 60 * 1000)

    await prisma.verificationToken.create({
      data: {
        identifier: emailLower,
        token: otp,
        expires,
      },
    })

    await sendVerificationOTP(emailLower, otp)

    return NextResponse.json({ message: 'A new verification code has been sent.' })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to resend OTP')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
