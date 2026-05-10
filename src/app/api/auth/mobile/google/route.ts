import { NextRequest, NextResponse } from 'next/server'
import { OAuth2Client } from 'google-auth-library'
import { prisma } from '@/lib/prisma'
import { signAccessToken, issueRefreshToken } from '@/lib/mobile-auth'
import { findUserByAnyEmail } from '@/lib/user-lookup'
import { checkRateLimit } from '@/lib/rate-limit'
import { apiLogger } from '@/lib/logger'

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown'

    const { limited } = await checkRateLimit('mobile-google', ip, 10, 15 * 60 * 1000)
    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      )
    }

    const body = await request.json()
    const { idToken } = body

    if (!idToken) {
      return NextResponse.json({ error: 'Google ID token is required' }, { status: 400 })
    }

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    })

    const payload = ticket.getPayload()
    if (!payload?.email || payload.email_verified !== true) {
      return NextResponse.json({ error: 'Invalid Google token' }, { status: 401 })
    }

    const email = payload.email.toLowerCase().trim()
    const name = payload.name || email.split('@')[0]
    const image = payload.picture || null

    // Find or create user
    let user = await findUserByAnyEmail(email)

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name,
          image,
          emailVerified: new Date(),
        },
        select: { id: true, email: true, name: true, image: true, role: true },
      })
    }

    // Auto-link Google account if not already linked
    const existingAccount = await prisma.account.findFirst({
      where: {
        userId: user.id,
        provider: 'google',
      },
    })

    if (!existingAccount) {
      await prisma.account.create({
        data: {
          userId: user.id,
          type: 'oauth',
          provider: 'google',
          providerAccountId: payload.sub,
        },
      })
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
    apiLogger.error({ err }, 'Mobile Google auth failed')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
