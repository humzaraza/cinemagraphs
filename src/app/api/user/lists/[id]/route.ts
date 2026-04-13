import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { id } = await params

    const list = await prisma.list.findFirst({
      where: { id, userId: session.user.id },
      select: {
        id: true,
        name: true,
        genreTag: true,
        createdAt: true,
        updatedAt: true,
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

    return NextResponse.json({
      ...list,
      films: list.films.map((f) => {
        const dp = f.film.sentimentGraph?.dataPoints as { score: number }[] | null | undefined
        return {
          id: f.film.id,
          title: f.film.title,
          posterUrl: f.film.posterUrl,
          year: f.film.releaseDate ? new Date(f.film.releaseDate).getFullYear() : null,
          score: f.film.sentimentGraph?.overallScore ?? null,
          runtime: f.film.runtime ?? null,
          sparklineData: dp?.map((d) => d.score) ?? null,
          dominantColor: null,
          addedAt: f.addedAt,
        }
      }),
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch list detail')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { id } = await params
    const body = await request.json()
    const { name, genreTag } = body

    // Verify ownership
    const existing = await prisma.list.findFirst({
      where: { id, userId: session.user.id },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }

    const updated = await prisma.list.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(genreTag !== undefined && { genreTag: genreTag || null }),
      },
      select: { id: true, name: true, genreTag: true, updatedAt: true },
    })

    return NextResponse.json(updated)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to update list')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { id } = await params

    // Verify ownership
    const existing = await prisma.list.findFirst({
      where: { id, userId: session.user.id },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }

    await prisma.list.delete({ where: { id } })

    return NextResponse.json({ message: 'List deleted' })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to delete list')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
