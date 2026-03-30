import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const announcement = await prisma.announcement.findFirst({
      where: { pinned: true },
      orderBy: { createdAt: 'desc' },
      include: {
        author: {
          select: { name: true, image: true },
        },
      },
    })

    if (!announcement) {
      return NextResponse.json({ announcement: null })
    }

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
    console.error('Failed to fetch announcement:', err)
    return NextResponse.json({ announcement: null })
  }
}
