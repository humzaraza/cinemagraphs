import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { getFriendsFeed, getIncomingFeed } from '@/lib/activity-feed'
import { apiLogger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const pageParam = request.nextUrl.searchParams.get('page')
    // Upper bound keeps skip inside Prisma's Int range and caps OFFSET scans.
    const page = Math.min(1000, Math.max(1, parseInt(pageParam ?? '1', 10) || 1))

    // Unknown tab values fall through to friends rather than erroring.
    const tab = request.nextUrl.searchParams.get('tab')
    const feed =
      tab === 'incoming'
        ? await getIncomingFeed(session.user.id, page)
        : await getFriendsFeed(session.user.id, page)
    return NextResponse.json(feed)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch activity feed')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
