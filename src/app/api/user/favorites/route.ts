import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { buildProfileResponse } from '@/lib/profile-response'

const FAVORITE_FILMS_MAX = 4

export async function PATCH(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { favoriteFilms } = body as { favoriteFilms?: unknown }

    if (!Array.isArray(favoriteFilms) || !favoriteFilms.every((id) => typeof id === 'string')) {
      return NextResponse.json(
        { error: 'favoriteFilms must be an array of film id strings' },
        { status: 400 }
      )
    }

    if (favoriteFilms.length > FAVORITE_FILMS_MAX) {
      return NextResponse.json(
        { error: `favoriteFilms cannot exceed ${FAVORITE_FILMS_MAX} entries` },
        { status: 400 }
      )
    }

    if (favoriteFilms.length > 0) {
      const [existingFilms, userReviews] = await Promise.all([
        prisma.film.findMany({
          where: { id: { in: favoriteFilms } },
          select: { id: true },
        }),
        prisma.userReview.findMany({
          where: { userId: session.user.id, filmId: { in: favoriteFilms } },
          select: { filmId: true },
        }),
      ])

      const existingIds = new Set(existingFilms.map((f) => f.id))
      for (const id of favoriteFilms) {
        if (!existingIds.has(id)) {
          return NextResponse.json({ error: `Film not found: ${id}` }, { status: 400 })
        }
      }

      const reviewedIds = new Set(userReviews.map((r) => r.filmId))
      for (const id of favoriteFilms) {
        if (!reviewedIds.has(id)) {
          return NextResponse.json(
            { error: `User has not reviewed film ${id}` },
            { status: 400 }
          )
        }
      }
    }

    await prisma.user.update({
      where: { id: session.user.id },
      data: { favoriteFilms },
    })

    const payload = await buildProfileResponse(session.user.id)
    if (!payload) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    return NextResponse.json(payload)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to update user favorites')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
