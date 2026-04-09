import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function POST(
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
    const { filmId } = body

    if (!filmId) {
      return NextResponse.json({ error: 'filmId is required' }, { status: 400 })
    }

    // Verify ownership
    const list = await prisma.list.findFirst({
      where: { id, userId: session.user.id },
      select: { id: true },
    })
    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }

    const listFilm = await prisma.listFilm.create({
      data: { listId: id, filmId },
      select: { id: true, filmId: true, addedAt: true },
    })

    return NextResponse.json(listFilm, { status: 201 })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : ''
    if (errorMessage.includes('Unique constraint')) {
      return NextResponse.json({ error: 'Film is already in this list' }, { status: 409 })
    }
    apiLogger.error({ err }, 'Failed to add film to list')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function DELETE(
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
    const { filmId } = body

    if (!filmId) {
      return NextResponse.json({ error: 'filmId is required' }, { status: 400 })
    }

    // Verify ownership
    const list = await prisma.list.findFirst({
      where: { id, userId: session.user.id },
      select: { id: true },
    })
    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }

    await prisma.listFilm.delete({
      where: { listId_filmId: { listId: id, filmId } },
    })

    return NextResponse.json({ message: 'Film removed from list' })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to remove film from list')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
