import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; filmId: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { id, filmId } = await params

    // Verify ownership
    const list = await prisma.list.findFirst({
      where: { id, userId: session.user.id },
      select: { id: true },
    })
    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }

    try {
      await prisma.listFilm.delete({
        where: { listId_filmId: { listId: id, filmId } },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.includes('Record to delete does not exist') || msg.includes('No record was found')) {
        return NextResponse.json({ error: 'Film is not in this list' }, { status: 404 })
      }
      throw err
    }

    // Bump list updatedAt so profile cards reflect the change
    await prisma.list.update({
      where: { id },
      data: { updatedAt: new Date() },
    })

    return NextResponse.json({ message: 'Film removed from list' })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to remove film from list (path param)')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
