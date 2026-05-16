import { NextRequest } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/middleware'
import { deleteUserAndAllData } from '@/lib/user-deletion'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin()
  if (!auth.authorized) return auth.errorResponse!

  const session = await getMobileOrServerSession()
  const currentUserId = session!.user.id

  const { id } = await params
  const body = await request.json()

  // Cannot change your own role
  if (body.role !== undefined && id === currentUserId) {
    return Response.json({ error: 'Cannot change your own role' }, { status: 400 })
  }

  const updateData: Record<string, unknown> = {}

  // Role update
  if (body.role !== undefined) {
    const validRoles = ['USER', 'MODERATOR', 'ADMIN', 'BANNED']
    if (!validRoles.includes(body.role)) {
      return Response.json({ error: 'Invalid role' }, { status: 400 })
    }
    updateData.role = body.role
  }

  // Suspension update
  if (body.suspendedUntil !== undefined) {
    if (id === currentUserId) {
      return Response.json({ error: 'Cannot suspend yourself' }, { status: 400 })
    }
    // null to unsuspend, or a date string
    updateData.suspendedUntil = body.suspendedUntil ? new Date(body.suspendedUntil) : null
  }

  const user = await prisma.user.update({
    where: { id },
    data: updateData,
    select: { id: true, role: true, suspendedUntil: true },
  })

  return Response.json(user)
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin()
  if (!auth.authorized) return auth.errorResponse!

  const session = await getMobileOrServerSession()
  const currentUserId = session!.user.id

  const { id } = await params

  // Cannot delete yourself
  if (id === currentUserId) {
    return Response.json({ error: 'Cannot delete your own account' }, { status: 400 })
  }

  // Verify user exists
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } })
  if (!user) {
    return Response.json({ error: 'User not found' }, { status: 404 })
  }

  await deleteUserAndAllData(id)

  return Response.json({ success: true })
}
