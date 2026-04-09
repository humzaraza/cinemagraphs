import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/middleware'
import { getMobileOrServerSession } from '@/lib/mobile-auth'

export async function POST(request: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.authorized) return auth.errorResponse!

  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Session user not found' }, { status: 401 })
    }
    const userId = session.user.id

    const body = await request.json()
    const message = (body.message || '').trim()

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    }
    if (message.length > 500) {
      return NextResponse.json({ error: 'Message must be 500 characters or less' }, { status: 400 })
    }

    // Unpin all existing announcements
    await prisma.announcement.updateMany({
      where: { pinned: true },
      data: { pinned: false },
    })

    // Create new pinned announcement
    const announcement = await prisma.announcement.create({
      data: {
        message,
        pinned: true,
        authorId: userId,
      },
      include: {
        author: {
          select: { name: true, image: true },
        },
      },
    })

    return NextResponse.json({
      announcement: {
        id: announcement.id,
        message: announcement.message,
        pinned: announcement.pinned,
        createdAt: announcement.createdAt.toISOString(),
        author: {
          name: announcement.author.name,
          image: announcement.author.image,
        },
      },
    })
  } catch (err) {
    console.error('Failed to create announcement:', err)
    return NextResponse.json({ error: 'Failed to create announcement' }, { status: 500 })
  }
}
