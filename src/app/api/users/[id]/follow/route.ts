import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ following: false })
    }

    const { id } = await params

    const follow = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: session.user.id,
          followingId: id,
        },
      },
    })

    return NextResponse.json({ following: !!follow })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to check follow status')
    return NextResponse.json({ following: false })
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { id } = await params

    if (session.user.id === id) {
      return NextResponse.json({ error: 'You cannot follow yourself' }, { status: 400 })
    }

    // Verify target user exists
    const targetUser = await prisma.user.findUnique({ where: { id }, select: { id: true } })
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    await prisma.follow.upsert({
      where: {
        followerId_followingId: {
          followerId: session.user.id,
          followingId: id,
        },
      },
      create: { followerId: session.user.id, followingId: id },
      update: {},
    })

    return NextResponse.json({ following: true })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to follow user')
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { id } = await params

    await prisma.follow.deleteMany({
      where: { followerId: session.user.id, followingId: id },
    })

    return NextResponse.json({ following: false })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to unfollow user')
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
