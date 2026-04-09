import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET() {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        publicProfile: true,
        allowFollowers: true,
        privateGraphs: true,
      },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    return NextResponse.json(user)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch user settings')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const body = await request.json()
    const { publicProfile, allowFollowers, privateGraphs } = body

    const data: Record<string, boolean> = {}
    if (typeof publicProfile === 'boolean') data.publicProfile = publicProfile
    if (typeof allowFollowers === 'boolean') data.allowFollowers = allowFollowers
    if (typeof privateGraphs === 'boolean') data.privateGraphs = privateGraphs

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const updated = await prisma.user.update({
      where: { id: session.user.id },
      data,
      select: {
        publicProfile: true,
        allowFollowers: true,
        privateGraphs: true,
      },
    })

    return NextResponse.json(updated)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to update user settings')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
