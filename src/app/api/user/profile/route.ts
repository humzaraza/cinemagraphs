import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import type { Prisma } from '@/generated/prisma/client'

export async function PATCH(request: NextRequest) {
  // TEMP: Log every step for debugging
  console.log('[PROFILE PATCH] Route hit')

  try {
    const session = await getServerSession(authOptions)
    console.log('[PROFILE PATCH] Session:', JSON.stringify(session?.user || null))

    if (!session?.user?.id) {
      console.log('[PROFILE PATCH] No session, returning 401')
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const body = await request.json()
    console.log('[PROFILE PATCH] Request body:', JSON.stringify(body))

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

    console.log('[PROFILE PATCH] Update data:', JSON.stringify(updateData))
    console.log('[PROFILE PATCH] Updating user:', session.user.id)

    const updated = await prisma.user.update({
      where: { id: session.user.id },
      data: updateData,
      select: { id: true, name: true, username: true, bio: true, image: true },
    })

    console.log('[PROFILE PATCH] Success:', JSON.stringify(updated))
    return NextResponse.json(updated)
  } catch (err) {
    // TEMP: Exhaustive error logging for debugging
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    const errorStack = err instanceof Error ? err.stack : undefined
    const errorName = err instanceof Error ? err.name : typeof err
    const errorCode = (err as Record<string, unknown>)?.code
    const errorMeta = (err as Record<string, unknown>)?.meta

    console.error('[PROFILE PATCH] ERROR name:', errorName)
    console.error('[PROFILE PATCH] ERROR message:', errorMessage)
    console.error('[PROFILE PATCH] ERROR code:', errorCode)
    console.error('[PROFILE PATCH] ERROR meta:', JSON.stringify(errorMeta))
    console.error('[PROFILE PATCH] ERROR stack:', errorStack)
    console.error('[PROFILE PATCH] ERROR full:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))

    apiLogger.error({ err, message: errorMessage }, 'Failed to update user profile')

    // Surface Prisma unique constraint violations
    if (errorMessage.includes('Unique constraint')) {
      return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 })
    }

    return NextResponse.json(
      {
        error: 'Something went wrong. Please try again.',
        _debug: {
          message: errorMessage,
          name: errorName,
          code: errorCode,
          meta: errorMeta,
        },
      },
      { status: 500 }
    )
  }
}
