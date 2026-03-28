import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function PATCH(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const body = await request.json()
    const { name, username, bio, image } = body

    // Validate username if provided
    if (username !== null && username !== undefined) {
      if (typeof username === 'string' && username.length > 0) {
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
          return NextResponse.json(
            { error: 'Username must be 3-20 characters, letters, numbers, and underscores only.' },
            { status: 400 }
          )
        }

        // Check uniqueness
        const existing = await prisma.user.findUnique({
          where: { username: username.toLowerCase() },
          select: { id: true },
        })
        if (existing && existing.id !== session.user.id) {
          return NextResponse.json(
            { error: 'That username is already taken.' },
            { status: 409 }
          )
        }
      }
    }

    // Validate name
    if (name !== null && name !== undefined && typeof name === 'string' && name.length > 50) {
      return NextResponse.json({ error: 'Name must be under 50 characters.' }, { status: 400 })
    }

    // Validate bio
    if (bio !== null && bio !== undefined && typeof bio === 'string' && bio.length > 160) {
      return NextResponse.json({ error: 'Bio must be under 160 characters.' }, { status: 400 })
    }

    const updateData: Record<string, unknown> = {}
    if (name !== undefined) updateData.name = name || null
    if (username !== undefined) updateData.username = username ? username.toLowerCase() : null
    if (bio !== undefined) updateData.bio = bio || null
    if (image !== undefined) updateData.image = image || null

    const updated = await prisma.user.update({
      where: { id: session.user.id },
      data: updateData,
      select: { id: true, name: true, username: true, bio: true, image: true },
    })

    return NextResponse.json(updated)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to update user profile')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
