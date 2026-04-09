import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const { token, password } = await request.json()

    if (!token || !password) {
      return NextResponse.json({ error: 'Token and password are required' }, { status: 400 })
    }

    if (typeof password !== 'string' || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { token },
    })

    if (!resetToken || resetToken.expires < new Date()) {
      return NextResponse.json({ error: 'Invalid or expired reset link. Please request a new one.' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { email: resetToken.email },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'Invalid or expired reset link.' }, { status: 400 })
    }

    const hashedPassword = await bcrypt.hash(password, 12)

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    })

    // Clean up all reset tokens for this email
    await prisma.passwordResetToken.deleteMany({
      where: { email: resetToken.email },
    })

    return NextResponse.json({ message: 'Password has been reset. You can now sign in.' })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to reset password')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
