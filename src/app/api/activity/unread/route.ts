import { NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { hasUnreadIncoming } from '@/lib/activity-feed'
import { apiLogger } from '@/lib/logger'

export async function GET() {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const unread = await hasUnreadIncoming(session.user.id)
    return NextResponse.json({ unread })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to check unread activity')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
