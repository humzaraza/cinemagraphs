import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { extractSentiment } from '@/lib/sentiment-extract'
import { maybeBlendAndUpdate } from '@/lib/review-blender'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const { id: filmId } = await params

  const film = await prisma.film.findUnique({
    where: { id: filmId },
    select: { id: true },
  })
  if (!film) {
    return NextResponse.json({ error: 'Film not found' }, { status: 404 })
  }

  // Check for existing review
  const existing = await prisma.userReview.findUnique({
    where: { userId_filmId: { userId: session.user.id, filmId } },
  })
  if (existing) {
    return NextResponse.json({ error: 'You have already reviewed this film' }, { status: 409 })
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

  const review = await prisma.userReview.create({
    data: {
      userId: session.user.id,
      filmId,
      overallRating: Math.round(overallRating * 2) / 2, // round to nearest 0.5
      beginning: beginning || null,
      middle: middle || null,
      ending: ending || null,
      otherThoughts: otherThoughts || null,
      combinedText,
      beatRatings: beatRatings || null,
      sentiment,
    },
    include: {
      user: { select: { id: true, name: true, image: true } },
    },
  })

  // Trigger blend check in background (don't block response)
  maybeBlendAndUpdate(filmId).catch(() => {})

  return NextResponse.json(review, { status: 201 })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: filmId } = await params
  const url = new URL(request.url)
  const page = parseInt(url.searchParams.get('page') || '1')
  const limit = 5

  const [reviews, total] = await Promise.all([
    prisma.userReview.findMany({
      where: { filmId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
    }),
    prisma.userReview.count({ where: { filmId } }),
  ])

  // Community summary
  const allReviews = await prisma.userReview.findMany({
    where: { filmId },
    select: { overallRating: true, sentiment: true, beginning: true, middle: true, ending: true },
  })

  const avgRating =
    allReviews.length > 0
      ? Math.round((allReviews.reduce((sum, r) => sum + r.overallRating, 0) / allReviews.length) * 10) / 10
      : null

  // Score distribution (1-10)
  const distribution = Array.from({ length: 10 }, (_, i) => ({
    score: i + 1,
    count: allReviews.filter((r) => Math.round(r.overallRating) === i + 1).length,
  }))

  // Section sentiment percentages
  const withBeginning = allReviews.filter((r) => r.beginning)
  const withMiddle = allReviews.filter((r) => r.middle)
  const withEnding = allReviews.filter((r) => r.ending)

  return NextResponse.json({
    reviews,
    total,
    page,
    totalPages: Math.ceil(total / limit),
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
}
