import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import type { Prisma } from '@/generated/prisma/client'

export async function GET() {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const userId = session.user.id
    const userEmail = session.user.email

    console.error('[profile] Looking up user', { userId, userEmail })

    // Look up by email first (more reliable across auth methods), fall back to id
    const user = userEmail
      ? await prisma.user.findUnique({ where: { email: userEmail }, select: profileSelect })
      : await prisma.user.findUnique({ where: { id: userId }, select: profileSelect })

    if (!user) {
      console.error('[profile] User not found by email, trying by id', { userId, userEmail })
      const fallback = await prisma.user.findUnique({ where: { id: userId }, select: profileSelect })
      if (!fallback) {
        console.error('[profile] User not found by id either — returning 404', { userId, userEmail })
        return NextResponse.json({ error: 'User not found' }, { status: 404 })
      }
      return buildProfileResponse(fallback)
    }

    console.error('[profile] User found', { id: user.id, email: user.email })
    return buildProfileResponse(user)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch user profile')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

const profileSelect = {
  id: true,
  name: true,
  username: true,
  bio: true,
  image: true,
  email: true,
  role: true,
  createdAt: true,
  _count: {
    select: {
      userReviews: true,
      watchlistItems: true,
      lists: true,
      following: true,
      followers: true,
    },
  },
} as const

function buildProfileResponse(user: {
  id: string
  name: string | null
  username: string | null
  bio: string | null
  image: string | null
  email: string
  role: string
  createdAt: Date
  _count: { userReviews: number; watchlistItems: number; lists: number; following: number; followers: number }
}) {
  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      bio: user.bio,
      image: user.image,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    },
    stats: {
      reviewCount: user._count.userReviews,
      watchedCount: user._count.userReviews,
      watchlistCount: user._count.watchlistItems,
      listCount: user._count.lists,
      followingCount: user._count.following,
      followerCount: user._count.followers,
    },
  })
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const body = await request.json()
    const { name, username, bio, image } = body

    // Validate username if provided
    if (username !== null && username !== undefined && typeof username === 'string' && username.length > 0) {
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        return NextResponse.json(
          { error: 'Username must be 3-20 characters, letters, numbers, and underscores only.' },
          { status: 400 }
        )
      }

      // Check uniqueness
      const existing = await prisma.user.findFirst({
        where: { username: username.toLowerCase(), NOT: { id: session.user.id } },
        select: { id: true },
      })
      if (existing) {
        return NextResponse.json(
          { error: 'That username is already taken.' },
          { status: 409 }
        )
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

    // Build a properly typed update object
    const updateData: Prisma.UserUpdateInput = {}

    if (name !== undefined) {
      updateData.name = (typeof name === 'string' && name.trim().length > 0) ? name.trim() : null
    }
    if (username !== undefined) {
      updateData.username = (typeof username === 'string' && username.trim().length > 0)
        ? username.trim().toLowerCase()
        : null
    }
    if (bio !== undefined) {
      updateData.bio = (typeof bio === 'string' && bio.trim().length > 0) ? bio.trim() : null
    }
    if (image !== undefined) {
      updateData.image = (typeof image === 'string' && image.length > 0) ? image : null
    }

    const updated = await prisma.user.update({
      where: { id: session.user.id },
      data: updateData,
      select: { id: true, name: true, username: true, bio: true, image: true },
    })

    return NextResponse.json(updated)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    apiLogger.error({ err, message: errorMessage }, 'Failed to update user profile')

    if (errorMessage.includes('Unique constraint')) {
      return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 })
    }

    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    )
  }
}
