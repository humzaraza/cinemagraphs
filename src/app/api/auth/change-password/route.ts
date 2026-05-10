import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { apiLogger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { limited } = await checkRateLimit('change-password', session.user.id, 5, 60 * 60 * 1000)
    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      )
    }

    const { currentPassword, newPassword } = await request.json()

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Current and new password are required' }, { status: 400 })
    }

    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, password: true },
    })

    if (!user || !user.password) {
      return NextResponse.json(
        { error: 'Cannot change password for accounts that use social login' },
        { status: 400 }
      )
    }

    const valid = await bcrypt.compare(currentPassword, user.password)
    if (!valid) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 })
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12)

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    })

    return NextResponse.json({ message: 'Password updated' })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to change password')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
