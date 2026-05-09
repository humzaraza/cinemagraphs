import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcrypt'
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

    const { limited } = checkRateLimit('mobile-login', ip, 10, 15 * 60 * 1000)
    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      )
    }

    const body = await request.json()
    const { email, password } = body

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    const emailLower = email.toLowerCase().trim()

    const user = await prisma.user.findUnique({
      where: { email: emailLower },
      select: { id: true, email: true, name: true, image: true, password: true, emailVerified: true, role: true },
    })

    if (!user?.password) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    if (!user.emailVerified) {
      return NextResponse.json({ error: 'Please verify your email before signing in' }, { status: 403 })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    const accessToken = signAccessToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      picture: user.image,
    })
    const refreshToken = await issueRefreshToken(user.id)

    return NextResponse.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        role: user.role,
      },
    })
  } catch (err) {
    apiLogger.error({ err }, 'Mobile login failed')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
