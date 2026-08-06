import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { extractSentiment } from '@/lib/sentiment-extract'
import { maybeBlendAndUpdate } from '@/lib/review-blender'
import { apiLogger } from '@/lib/logger'
import { checkSuspension } from '@/lib/middleware'
import { invalidateFilmCache } from '@/lib/cache'
import { getFilmReviewsPage, getUserReviewForFilm } from '@/lib/film-detail'
import { logActivity } from '@/lib/activity'
import { Prisma } from '@/generated/prisma/client'

// TEMPORARY: auto-moderation bypass per admin request. When false, every
// new review and every edit goes live as `approved` — autoModerate() is
// not called, and edits no longer force re-flagging. Flip back to `true`
// to restore the original moderation flow; all the logic below (the
// autoModerate function, the edit re-flag path) is kept intact so no
// re-implementation is needed.
const AUTO_MODERATION_ENABLED = false

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
      select: {
        id: true,
        sentimentGraph: { select: { dataPoints: true } },
        filmBeats: { select: { beats: true } },
      },
    })
    if (!film) {
      return NextResponse.json({ error: 'Film not found' }, { status: 404 })
    }

    const body = await request.json()
    const { overallRating, beginning, middle, ending, otherThoughts, beatRatings } = body

    if (typeof overallRating !== 'number' || overallRating < 1 || overallRating > 10) {
      return NextResponse.json({ error: 'Overall rating must be between 1 and 10' }, { status: 400 })
    }

    // Normalize beatRatings before either write path. Absent or null means
    // the reviewer submitted no beat ratings at all.
    let normalizedBeatRatings: Record<string, number> | null = null
    if (beatRatings !== undefined && beatRatings !== null) {
      if (typeof beatRatings !== 'object' || Array.isArray(beatRatings)) {
        return NextResponse.json(
          { error: 'Beat ratings must be an object mapping beat labels to scores' },
          { status: 400 }
        )
      }
      for (const [label, value] of Object.entries(beatRatings as Record<string, unknown>)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return NextResponse.json(
            { error: `Beat rating for "${label}" must be a number` },
            { status: 400 }
          )
        }
        if (value < 1 || value > 10) {
          return NextResponse.json(
            { error: `Beat rating for "${label}" must be between 1 and 10` },
            { status: 400 }
          )
        }
      }

      // Keep only keys that match a beat label the composer actually offers,
      // mirroring the film page's precedence: sentiment-graph beats when a
      // graph exists, wiki-sourced filmBeats otherwise. Unknown keys are
      // dropped rather than rejected: a stale client whose cached beat
      // labels have since been regenerated should still be able to submit,
      // minus the beats that no longer exist.
      const labelSource = film.sentimentGraph
        ? film.sentimentGraph.dataPoints
        : film.filmBeats?.beats
      const validLabels = new Set(
        Array.isArray(labelSource)
          ? (labelSource as unknown as { label?: unknown }[])
              .map((p) => p?.label)
              .filter((l): l is string => typeof l === 'string')
          : []
      )
      const filtered: Record<string, number> = {}
      for (const [label, value] of Object.entries(beatRatings as Record<string, number>)) {
        if (validLabels.has(label)) filtered[label] = value
      }

      // An empty map after filtering means the reviewer asserted nothing
      // about the film's shape. Store null to say that honestly; {} would
      // read as an assertion of nothing.
      normalizedBeatRatings = Object.keys(filtered).length > 0 ? filtered : null
    }

    // Build combined text from non-empty sections
    const sections = [beginning, middle, ending, otherThoughts].filter(
      (s) => typeof s === 'string' && s.trim().length > 0
    )
    const combinedText = sections.length > 0 ? sections.join(' ') : null

    // Extract sentiment from combined text
    const sentiment = combinedText ? await extractSentiment(combinedText) : null

    // Get user creation date for moderation (still fetched when bypass is
    // active — autoModerate needs it and we want flipping the flag back on
    // to be a single-line change).
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { createdAt: true },
    })

    let status: string = 'approved'
    let flagReason: string | null = null
    if (AUTO_MODERATION_ENABLED) {
      const moderation = autoModerate(
        normalizedBeatRatings,
        [beginning, middle, ending, otherThoughts],
        user?.createdAt ?? new Date()
      )
      status = moderation.status
      flagReason = moderation.flagReason
    }

    // Check for existing review — if exists, update (edit mode)
    const existing = await prisma.userReview.findUnique({
      where: { userId_filmId: { userId: session.user.id, filmId } },
    })

    if (existing) {
      // Editing — when moderation is on, autoModerate runs AND any
      // otherwise-clean edit is force-flagged with "Edited review —
      // re-moderation". With the bypass active, edits stay approved.
      let editStatus: string = 'approved'
      let editFlagReason: string | null = null
      if (AUTO_MODERATION_ENABLED) {
        const editModeration = autoModerate(
          normalizedBeatRatings,
          [beginning, middle, ending, otherThoughts],
          user?.createdAt ?? new Date()
        )
        if (editModeration.status === 'approved') {
          editStatus = 'flagged'
          editFlagReason = 'Edited review — re-moderation'
        } else {
          editStatus = editModeration.status
          editFlagReason = editModeration.flagReason
        }
      }

      const review = await prisma.userReview.update({
        where: { id: existing.id },
        data: {
          overallRating: Math.round(overallRating * 2) / 2,
          beginning: beginning || null,
          middle: middle || null,
          ending: ending || null,
          otherThoughts: otherThoughts || null,
          combinedText,
          beatRatings: normalizedBeatRatings ?? Prisma.DbNull,
          sentiment,
          status: editStatus,
          flagReason: editFlagReason,
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
        beatRatings: normalizedBeatRatings ?? Prisma.DbNull,
        sentiment,
        status,
        flagReason,
      },
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
    })

    if (review.status === 'approved') {
      await logActivity({ actorId: session.user.id, type: 'review', reviewId: review.id, filmId })
    }

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
    const excludeCurrentUser = url.searchParams.get('excludeCurrentUser') === 'true'

    const session = await getMobileOrServerSession()
    const userId = session?.user?.id ?? null

    // Mobile "Your review" pattern: when the caller renders the current
    // user's review in its own section, the paginated list omits it to
    // avoid duplication. Unauthenticated callers get a no-op.
    const excludeUserId = excludeCurrentUser && userId ? userId : null

    // getFilmReviewsPage + getUserReviewForFilm are the shared source of
    // truth, also used directly by the detail page's server render.
    const [reviewsPage, myReview] = await Promise.all([
      getFilmReviewsPage(filmId, page, excludeUserId),
      userId ? getUserReviewForFilm(filmId, userId) : Promise.resolve(null),
    ])

    return NextResponse.json({ ...reviewsPage, myReview })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch reviews')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
