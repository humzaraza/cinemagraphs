import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { maybeBlendAndUpdate } from '@/lib/review-blender'
import { apiLogger } from '@/lib/logger'
import { checkSuspension } from '@/lib/middleware'

const REACTION_WEIGHTS: Record<string, number> = {
  up: 0.5,
  down: -0.5,
  wow: 1.0,
  shock: 0.5,
  funny: 0.3,
}

const RATE_LIMIT_MS = 10_000 // 1 reaction per 10 seconds

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
  const session = await getMobileOrServerSession()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const suspended = await checkSuspension(session.user.id)
  if (suspended) return suspended

  const { id: filmId } = await params
  const body = await request.json()
  const { reaction, sessionTimestamp, currentScore, sessionId } = body

  if (!REACTION_WEIGHTS[reaction]) {
    return NextResponse.json({ error: 'Invalid reaction type' }, { status: 400 })
  }
  if (typeof sessionTimestamp !== 'number' || sessionTimestamp < 0) {
    return NextResponse.json({ error: 'Invalid session timestamp' }, { status: 400 })
  }

  // Rate limiting: check last reaction from this user on this film
  const lastReaction = await prisma.liveReaction.findFirst({
    where: { userId: session.user.id, filmId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })

  if (lastReaction) {
    const elapsed = Date.now() - lastReaction.createdAt.getTime()
    if (elapsed < RATE_LIMIT_MS) {
      const waitSec = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000)
      return NextResponse.json(
        { error: `Rate limited. Wait ${waitSec}s.` },
        { status: 429 }
      )
    }
  }

  // Calculate score nudge
  const weight = REACTION_WEIGHTS[reaction]
  const baseScore = typeof currentScore === 'number' ? currentScore : 5
  const newScore = Math.max(1, Math.min(10, baseScore + weight))

  const liveReaction = await prisma.liveReaction.create({
    data: {
      userId: session.user.id,
      filmId,
      reaction,
      score: Math.round(newScore * 10) / 10,
      sessionTimestamp,
      sessionId: sessionId || null,
    },
  })

  // Update session if provided
  if (sessionId) {
    const film = await prisma.film.findUnique({
      where: { id: filmId },
      select: { runtime: true },
    })
    const totalSeconds = (film?.runtime || 120) * 60
    const completionRate = Math.min(1, sessionTimestamp / totalSeconds)

    await prisma.liveReactionSession.update({
      where: { id: sessionId },
      data: {
        lastReactionAt: new Date(),
        completionRate: Math.round(completionRate * 100) / 100,
      },
    })

    // Auto-flag: check if 80%+ of reactions are the same type
    const sessionReactions = await prisma.liveReaction.findMany({
      where: { sessionId },
      select: { reaction: true },
    })
    if (sessionReactions.length >= 10) {
      const counts: Record<string, number> = {}
      for (const r of sessionReactions) {
        counts[r.reaction] = (counts[r.reaction] || 0) + 1
      }
      const maxCount = Math.max(...Object.values(counts))
      if (maxCount / sessionReactions.length >= 0.8) {
        await prisma.liveReactionSession.update({
          where: { id: sessionId },
          data: {
            flagged: true,
            flagReason: `${Math.round((maxCount / sessionReactions.length) * 100)}% same reaction type`,
          },
        })
      }
    }
  }

  // Trigger blend check in background
  maybeBlendAndUpdate(filmId).catch(() => {})

  return NextResponse.json({
    id: liveReaction.id,
    score: liveReaction.score,
    reaction: liveReaction.reaction,
  }, { status: 201 })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to submit reaction')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: filmId } = await params

    const reactions = await prisma.liveReaction.findMany({
      where: { filmId },
      orderBy: { sessionTimestamp: 'asc' },
      select: { reaction: true, score: true, sessionTimestamp: true, createdAt: true },
    })

    // Aggregate counts
    const counts: Record<string, number> = { up: 0, down: 0, wow: 0, shock: 0, funny: 0 }
    for (const r of reactions) {
      counts[r.reaction] = (counts[r.reaction] || 0) + 1
    }

    return NextResponse.json({
      total: reactions.length,
      counts,
      reactions: reactions.slice(-100), // last 100 for timeline display
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch reactions')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
