import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// GET: Check for an incomplete session
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const { id: filmId } = await params

  const incomplete = await prisma.liveReactionSession.findFirst({
    where: {
      userId: session.user.id,
      filmId,
      completionRate: { lt: 1.0 },
    },
    orderBy: { startedAt: 'desc' },
    include: {
      reactions: {
        orderBy: { sessionTimestamp: 'asc' },
        select: { reaction: true, score: true, sessionTimestamp: true },
      },
    },
  })

  return NextResponse.json({ session: incomplete })
}

// POST: Create a new session or abandon old and create new
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authSession = await getServerSession(authOptions)
  if (!authSession?.user?.id) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const { id: filmId } = await params
  const body = await request.json().catch(() => ({}))
  const { abandonPrevious } = body

  if (abandonPrevious) {
    // Mark all incomplete sessions as complete (abandoned)
    await prisma.liveReactionSession.updateMany({
      where: {
        userId: authSession.user.id,
        filmId,
        completionRate: { lt: 1.0 },
      },
      data: { completionRate: 1.0 },
    })
  }

  const newSession = await prisma.liveReactionSession.create({
    data: {
      userId: authSession.user.id,
      filmId,
      lastReactionAt: new Date(),
    },
  })

  return NextResponse.json({ session: newSession }, { status: 201 })
}
