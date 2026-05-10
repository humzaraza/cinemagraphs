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

    const { limited } = await checkRateLimit('register', ip, 5, 15 * 60 * 1000)
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

    if (existingUser?.emailVerified && existingUser.password) {
      // Case A: verified account already exists. Reject.
      return NextResponse.json(
        { error: 'Unable to create account. Try signing in instead.' },
        { status: 409 }
      )
    }

    const hashedPassword = await bcrypt.hash(password, 12)
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const expires = new Date(Date.now() + 10 * 60 * 1000)

    // Clear any stale verification tokens before creating a new one.
    await prisma.verificationToken.deleteMany({ where: { identifier: emailLower } })

    if (!existingUser) {
      // Case B: brand new user. Create.
      await prisma.user.create({
        data: { email: emailLower, password: hashedPassword, name: name || emailLower.split('@')[0] },
      })
    } else if (!existingUser.password) {
      // Case C: OAuth-only user adding password authentication. Update in place.
      await prisma.user.update({
        where: { id: existingUser.id },
        data: { password: hashedPassword, name: name || undefined },
      })
    } else {
      // Case D: unverified user with password. Reset by deleting and recreating.
      // The unverified record never had verified data attached, so destruction is safe.
      await prisma.user.delete({ where: { id: existingUser.id } })
      await prisma.user.create({
        data: { email: emailLower, password: hashedPassword, name: name || emailLower.split('@')[0] },
      })
    }

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
