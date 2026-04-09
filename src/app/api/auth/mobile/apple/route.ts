import { NextRequest, NextResponse } from 'next/server'
import appleSignin from 'apple-signin-auth'
import { prisma } from '@/lib/prisma'
import { signMobileToken } from '@/lib/mobile-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { apiLogger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown'

    const { limited } = checkRateLimit('mobile-apple', ip, 10, 15 * 60 * 1000)
    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      )
    }

    const body = await request.json()
    const { identityToken, fullName } = body

    if (!identityToken) {
      return NextResponse.json({ error: 'Apple identity token is required' }, { status: 400 })
    }

    // Verify the Apple identity token
    const applePayload = await appleSignin.verifyIdToken(identityToken, {
      audience: process.env.APPLE_ID,
    })

    if (!applePayload.email) {
      return NextResponse.json({ error: 'Invalid Apple token' }, { status: 401 })
    }

    const email = applePayload.email.toLowerCase().trim()
    const appleSub = applePayload.sub

    // Build name from fullName (Apple only sends this on first sign-in)
    const name = fullName
      ? [fullName.givenName, fullName.familyName].filter(Boolean).join(' ') || email.split('@')[0]
      : null

    // Find or create user
    let user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, image: true, role: true },
    })

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: name || email.split('@')[0],
          emailVerified: new Date(),
        },
        select: { id: true, email: true, name: true, image: true, role: true },
      })
    } else if (name && !user.name) {
      // Update name if we have it and user does not
      user = await prisma.user.update({
        where: { id: user.id },
        data: { name },
        select: { id: true, email: true, name: true, image: true, role: true },
      })
    }

    // Auto-link Apple account if not already linked
    const existingAccount = await prisma.account.findFirst({
      where: {
        userId: user.id,
        provider: 'apple',
      },
    })

    if (!existingAccount) {
      await prisma.account.create({
        data: {
          userId: user.id,
          type: 'oauth',
          provider: 'apple',
          providerAccountId: appleSub,
        },
      })
    }

    const token = signMobileToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      picture: user.image,
    })

    return NextResponse.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        role: user.role,
      },
    })
  } catch (err) {
    apiLogger.error({ err }, 'Mobile Apple auth failed')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
