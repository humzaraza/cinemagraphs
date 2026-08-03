import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { getFriendsFeed, getIncomingFeed } from '@/lib/activity-feed'
import ActivityFeed from '@/components/ActivityFeed'

export const dynamic = 'force-dynamic'

export default async function ActivityPage() {
  const session = await getServerSession(authOptions)

  if (!session?.user?.id) {
    redirect('/auth/signin')
  }

  // Both tabs' first pages are fetched up front so switching tabs is instant.
  const [initialFriends, initialIncoming] = await Promise.all([
    getFriendsFeed(session.user.id, 1),
    getIncomingFeed(session.user.id, 1),
  ])

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="font-[family-name:var(--font-playfair)] text-3xl font-bold text-cinema-cream mb-6">
        Activity
      </h1>
      <ActivityFeed initialFriends={initialFriends} initialIncoming={initialIncoming} />
    </div>
  )
}
