import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { extractSentiment } from '@/lib/sentiment-extract'
import { maybeBlendAndUpdate } from '@/lib/review-blender'
import { apiLogger } from '@/lib/logger'
import { checkSuspension } from '@/lib/middleware'
import { invalidateFilmCache } from '@/lib/cache'

const GIBBERISH_REGEX = /(.)\1{5,}|^[a-z]{1,3}(\s[a-z]{1,3}){10,}$/i

function autoModerate(
  beatRatings: Record<string, number> | null,
  textSections: (string | null)[],
  userCreatedAt: Date
): { status: string; flagReason: string | null } {
  const reasons: string[] = []

  // Check for gibberish in text
  const filledSections = textSections.filter((s): s is string => !!s && s.trim().length > 0)
  for (const section of filledSections) {
    if (GIBBERISH_REGEX.test(section.trim())) {
      return { status: 'rejected', flagReason: 'Detected gibberish text' }
    }
  }

  // All beat ratings identical
  if (beatRatings) {
    const values = Object.values(beatRatings)
    if (values.length > 1 && values.every((v) => v === values[0])) {
      reasons.push('All beat ratings are identical')
    }
  }

  // Short text sections
  for (const section of filledSections) {
    const wordCount = section.trim().split(/\s+/).length
    if (wordCount < 20) {
      reasons.push('Text section under 20 words')
      break
    }
  }

  // New account (created < 24h ago)
  const hoursSinceCreation = (Date.now() - userCreatedAt.getTime()) / (1000 * 60 * 60)
  if (hoursSinceCreation < 24) {
    reasons.push('Account created less than 24 hours ago')
  }

  if (reasons.length > 0) {
    return { status: 'flagged', flagReason: reasons.join('; ') }
  }

  return { status: 'approved', flagReason: null }
}

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

    const film = await prisma.film.findUnique({
      where: { id: filmId },
      select: { id: true },
    })
    if (!film) {
      return NextResponse.json({ error: 'Film not found' }, { status: 404 })
    }

    const body = await request.json()
    const { overallRating, beginning, middle, ending, otherThoughts, beatRatings } = body

    if (typeof overallRating !== 'number' || overallRating < 1 || overallRating > 10) {
      return NextResponse.json({ error: 'Overall rating must be between 1 and 10' }, { status: 400 })
    }

    // Build combined text from non-empty sections
    const sections = [beginning, middle, ending, otherThoughts].filter(
      (s) => typeof s === 'string' && s.trim().length > 0
    )
    const combinedText = sections.length > 0 ? sections.join(' ') : null

    // Extract sentiment from combined text
    const sentiment = combinedText ? await extractSentiment(combinedText) : null

    // Get user creation date for moderation
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { createdAt: true },
    })

    const { status, flagReason } = autoModerate(
      beatRatings || null,
      [beginning, middle, ending, otherThoughts],
      user?.createdAt ?? new Date()
    )

    // Check for existing review — if exists, update (edit mode)
    const existing = await prisma.userReview.findUnique({
      where: { userId_filmId: { userId: session.user.id, filmId } },
    })

    if (existing) {
      // Editing — always re-flag for moderation
      const editModeration = autoModerate(
        beatRatings || null,
        [beginning, middle, ending, otherThoughts],
        user?.createdAt ?? new Date()
      )

      const review = await prisma.userReview.update({
        where: { id: existing.id },
        data: {
          overallRating: Math.round(overallRating * 2) / 2,
          beginning: beginning || null,
          middle: middle || null,
          ending: ending || null,
          otherThoughts: otherThoughts || null,
          combinedText,
          beatRatings: beatRatings || null,
          sentiment,
          status: editModeration.status === 'approved' ? 'flagged' : editModeration.status,
          flagReason: editModeration.status === 'approved' ? 'Edited review — re-moderation' : editModeration.flagReason,
        },
        include: {
          user: { select: { id: true, name: true, image: true } },
        },
      })

      invalidateFilmCache(filmId).catch(() => {})
      maybeBlendAndUpdate(filmId).catch(() => {})
      return NextResponse.json(review)
    }

    const review = await prisma.userReview.create({
      data: {
        userId: session.user.id,
        filmId,
        overallRating: Math.round(overallRating * 2) / 2,
        beginning: beginning || null,
        middle: middle || null,
        ending: ending || null,
        otherThoughts: otherThoughts || null,
        combinedText,
        beatRatings: beatRatings || null,
        sentiment,
        status,
        flagReason,
      },
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
    })

    invalidateFilmCache(filmId).catch(() => {})
    maybeBlendAndUpdate(filmId).catch(() => {})

    return NextResponse.json(review, { status: 201 })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to submit review')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: filmId } = await params
    const url = new URL(request.url)
    const page = parseInt(url.searchParams.get('page') || '1')
    const limit = 5

    // Check if current user has a review (any status)
    const session = await getMobileOrServerSession()
    let myReview = null
    if (session?.user?.id) {
      myReview = await prisma.userReview.findUnique({
        where: { userId_filmId: { userId: session.user.id, filmId } },
        include: {
          user: { select: { id: true, name: true, image: true } },
        },
      })
    }

    const approvedFilter = { filmId, status: 'approved' }

    const [reviews, total] = await Promise.all([
      prisma.userReview.findMany({
        where: approvedFilter,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, name: true, image: true } },
        },
      }),
      prisma.userReview.count({ where: approvedFilter }),
    ])

    // Community summary (approved only)
    const allReviews = await prisma.userReview.findMany({
      where: approvedFilter,
      select: { overallRating: true, sentiment: true, beginning: true, middle: true, ending: true },
    })

    const avgRating =
      allReviews.length > 0
        ? Math.round((allReviews.reduce((sum, r) => sum + r.overallRating, 0) / allReviews.length) * 10) / 10
        : null

    const distribution = Array.from({ length: 10 }, (_, i) => ({
      score: i + 1,
      count: allReviews.filter((r) => Math.round(r.overallRating) === i + 1).length,
    }))

    const withBeginning = allReviews.filter((r) => r.beginning)
    const withMiddle = allReviews.filter((r) => r.middle)
    const withEnding = allReviews.filter((r) => r.ending)

    return NextResponse.json({
      reviews,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      myReview,
      summary: {
        avgRating,
        totalReviews: total,
        distribution,
        sectionCounts: {
          beginning: withBeginning.length,
          middle: withMiddle.length,
          ending: withEnding.length,
        },
      },
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch reviews')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
