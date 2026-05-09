import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { prisma } from '@/lib/prisma'
import { sendPasswordResetEmail } from '@/lib/email'
import { checkRateLimit } from '@/lib/rate-limit'
import { apiLogger } from '@/lib/logger'
import { findUserByAnyEmail } from '@/lib/user-lookup'

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown'

    const { limited } = checkRateLimit('forgot-password', ip, 3, 15 * 60 * 1000)
    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      )
    }

    const { email } = await request.json()
    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const emailLower = email.toLowerCase().trim()

    // Always return success to avoid leaking account existence
    const identity = await findUserByAnyEmail(emailLower)
    const user = identity
      ? await prisma.user.findUnique({
          where: { id: identity.id },
          select: { id: true, password: true },
        })
      : null

    if (user?.password) {
      // Generate secure token
      const token = randomBytes(32).toString('hex')
      const expires = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

      // Invalidate existing tokens
      await prisma.passwordResetToken.deleteMany({
        where: { email: emailLower },
      })

      await prisma.passwordResetToken.create({
        data: { email: emailLower, token, expires },
      })

      const resetUrl = `https://cinemagraphs.ca/auth/reset-password?token=${token}`
      await sendPasswordResetEmail(emailLower, resetUrl)
    }

    return NextResponse.json({ message: 'If an account exists, a reset link has been sent.' })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to send password reset')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
