import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const url = new URL(request.url)
    const status = url.searchParams.get('status') || 'flagged'
    const search = url.searchParams.get('search') || ''

    const where: any = {}

    if (status !== 'all') {
      where.status = status
    }

    if (search.trim()) {
      where.OR = [
        { film: { title: { contains: search, mode: 'insensitive' } } },
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ]
    }

    const reviews = await prisma.userReview.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
        film: { select: { id: true, title: true, posterUrl: true } },
      },
    })

    // Also return flagged count for badge
    const flaggedCount = await prisma.userReview.count({ where: { status: 'flagged' } })

    return NextResponse.json({ reviews, flaggedCount })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch admin reviews')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
