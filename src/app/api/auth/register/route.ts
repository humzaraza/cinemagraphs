import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcrypt'
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

    const { limited } = checkRateLimit('register', ip, 5, 15 * 60 * 1000)
    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      )
    }

    const body = await request.json()
    const { email, password, name } = body

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    if (typeof password !== 'string' || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    const emailLower = email.toLowerCase().trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: emailLower },
      select: { id: true, password: true, emailVerified: true },
    })

    // If user exists with a verified email and password, don't allow re-registration
    if (existingUser?.password && existingUser.emailVerified) {
      return NextResponse.json({ error: 'Unable to create account. Try signing in instead.' }, { status: 409 })
    }

    // If user exists but is unverified (stuck registration), delete and start fresh
    if (existingUser && !existingUser.emailVerified && existingUser.password) {
      await prisma.verificationToken.deleteMany({ where: { identifier: emailLower } })
      await prisma.user.delete({ where: { id: existingUser.id } })
    }

    const hashedPassword = await bcrypt.hash(password, 12)

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const expires = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

    if (existingUser && !existingUser.emailVerified && !existingUser.password) {
      // User exists via OAuth but no password — add password
      await prisma.user.update({
        where: { id: existingUser.id },
        data: { password: hashedPassword, name: name || undefined },
      })
    } else if (!existingUser || (!existingUser.emailVerified && existingUser.password)) {
      // Create new user
      await prisma.user.create({
        data: {
          email: emailLower,
          password: hashedPassword,
          name: name || emailLower.split('@')[0],
        },
      })
    }

    // Store OTP in VerificationToken
    // Delete any existing tokens for this email first
    await prisma.verificationToken.deleteMany({
      where: { identifier: emailLower },
    })

    await prisma.verificationToken.create({
      data: {
        identifier: emailLower,
        token: otp,
        expires,
      },
    })

    // Send OTP email
    await sendVerificationOTP(emailLower, otp)

    return NextResponse.json({ message: 'Verification code sent to your email' }, { status: 201 })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to register user')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
