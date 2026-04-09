import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type')

    if (type === 'reviewed') {
      const reviews = await prisma.userReview.findMany({
        where: { userId: session.user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          overallRating: true,
          createdAt: true,
          film: {
            select: {
              id: true,
              title: true,
              posterUrl: true,
              releaseDate: true,
              genres: true,
              sentimentGraph: {
                select: { dataPoints: true },
              },
            },
          },
        },
      })

      return NextResponse.json({
        films: reviews.map((r) => ({
          id: r.film.id,
          title: r.film.title,
          posterUrl: r.film.posterUrl,
          year: r.film.releaseDate ? new Date(r.film.releaseDate).getFullYear() : null,
          genres: r.film.genres,
          reviewScore: r.overallRating,
          reviewDate: r.createdAt,
          sparkline: r.film.sentimentGraph?.dataPoints ?? null,
        })),
      })
    }

    if (type === 'watched') {
      const watchlist = await prisma.watchlist.findMany({
        where: { userId: session.user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          film: {
            select: {
              id: true,
              title: true,
              posterUrl: true,
              releaseDate: true,
            },
          },
        },
      })

      return NextResponse.json({
        films: watchlist.map((w) => ({
          id: w.film.id,
          title: w.film.title,
          posterUrl: w.film.posterUrl,
          year: w.film.releaseDate ? new Date(w.film.releaseDate).getFullYear() : null,
        })),
      })
    }

    return NextResponse.json({ error: 'Query param "type" must be "reviewed" or "watched"' }, { status: 400 })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch user films')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
