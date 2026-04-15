import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

// Public list detail: anyone can fetch a public list; private lists require the owner.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const list = await prisma.list.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        genreTag: true,
        description: true,
        isPublic: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: { id: true, name: true, username: true, image: true },
        },
        films: {
          orderBy: { addedAt: 'desc' },
          select: {
            addedAt: true,
            film: {
              select: {
                id: true,
                title: true,
                posterUrl: true,
                releaseDate: true,
                runtime: true,
                genres: true,
                sentimentGraph: {
                  select: { overallScore: true, dataPoints: true },
                },
              },
            },
          },
        },
      },
    })

    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }

    if (!list.isPublic) {
      const session = await getMobileOrServerSession()
      if (!session?.user?.id || session.user.id !== list.userId) {
        return NextResponse.json({ error: 'List not found' }, { status: 404 })
      }
    }

    const films = list.films.map((f) => {
      const dp = f.film.sentimentGraph?.dataPoints as { score: number }[] | null | undefined
      return {
        id: f.film.id,
        title: f.film.title,
        posterUrl: f.film.posterUrl,
        year: f.film.releaseDate ? new Date(f.film.releaseDate).getFullYear() : null,
        runtime: f.film.runtime ?? null,
        genres: f.film.genres ?? [],
        score: f.film.sentimentGraph?.overallScore ?? null,
        sparklineData: Array.isArray(dp) ? dp.map((d) => d.score) : null,
        addedAt: f.addedAt,
      }
    })

    return NextResponse.json({
      id: list.id,
      name: list.name,
      genreTag: list.genreTag,
      description: list.description,
      isPublic: list.isPublic,
      filmCount: films.length,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
      owner: {
        id: list.user.id,
        name: list.user.name,
        username: list.user.username,
        image: list.user.image,
      },
      films,
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch public list detail')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
