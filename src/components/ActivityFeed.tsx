'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tmdbImageUrl } from '@/lib/utils'
import type { FeedActor, FeedFilm, FeedItem, FriendsFeedPage } from '@/lib/activity-feed'

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
  const diffMonth = Math.floor(diffDay / 30)
  return `${diffMonth} month${diffMonth === 1 ? '' : 's'} ago`
}

function displayName(user: FeedActor): string {
  return user.name ?? 'Someone'
}

function Avatar({ user }: { user: FeedActor }) {
  if (user.image) {
    return (
      <Image
        src={user.image}
        alt={displayName(user)}
        width={36}
        height={36}
        className="rounded-full shrink-0"
      />
    )
  }
  const initial = (user.name || '?')[0].toUpperCase()
  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
      style={{
        background: 'linear-gradient(135deg, var(--cinema-gold), #a08530)',
        color: 'var(--cinema-dark)',
      }}
    >
      {initial}
    </div>
  )
}

function PosterThumb({ film }: { film: FeedFilm }) {
  return (
    <Image
      src={tmdbImageUrl(film.posterUrl, 'w92')}
      alt={film.title}
      width={40}
      height={60}
      className="rounded shrink-0 object-cover"
    />
  )
}

function ActorLink({ user }: { user: FeedActor }) {
  return (
    <Link
      href={`/profile/${user.id}`}
      className="font-semibold text-cinema-cream hover:text-cinema-gold transition-colors"
    >
      {displayName(user)}
    </Link>
  )
}

function FeedSentence({ item }: { item: FeedItem }) {
  switch (item.type) {
    case 'review':
      if (!item.review || !item.film) return null
      return (
        <>
          <ActorLink user={item.actor} /> reviewed{' '}
          <Link
            href={`/reviews/${item.review.id}`}
            className="text-cinema-gold hover:text-cinema-gold/80 transition-colors"
          >
            {item.film.title}
          </Link>
        </>
      )
    case 'follow':
      if (!item.targetUser) return null
      return (
        <>
          <ActorLink user={item.actor} /> followed <ActorLink user={item.targetUser} />
        </>
      )
    case 'watchlist':
      if (!item.film) return null
      return (
        <>
          <ActorLink user={item.actor} /> added{' '}
          <Link
            href={`/films/${item.film.id}`}
            className="text-cinema-gold hover:text-cinema-gold/80 transition-colors"
          >
            {item.film.title}
          </Link>{' '}
          to their watchlist
        </>
      )
    case 'list_add':
      if (!item.film || !item.list) return null
      return (
        <>
          <ActorLink user={item.actor} /> added{' '}
          <Link
            href={`/films/${item.film.id}`}
            className="text-cinema-gold hover:text-cinema-gold/80 transition-colors"
          >
            {item.film.title}
          </Link>{' '}
          to{' '}
          <Link
            href={`/lists/${item.list.id}`}
            className="text-cinema-gold hover:text-cinema-gold/80 transition-colors"
          >
            {item.list.name}
          </Link>
        </>
      )
    default:
      return null
  }
}

export default function ActivityFeed({ initialData }: { initialData: FriendsFeedPage }) {
  const [items, setItems] = useState<FeedItem[]>(initialData.items)
  const [page, setPage] = useState(initialData.page)
  const [hasMore, setHasMore] = useState(initialData.hasMore)
  const [loading, setLoading] = useState(false)

  const handleLoadMore = async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/activity?page=${page + 1}`)
      if (!res.ok) throw new Error()
      const data: FriendsFeedPage = await res.json()
      // Dedupe on append: referent-dropping backfills a page from the next
      // page's offset window, so consecutive pages can overlap.
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.id))
        return [...prev, ...data.items.filter((item) => !seen.has(item.id))]
      })
      setPage(data.page)
      setHasMore(data.hasMore)
    } catch {
      // Keep current items; the button stays visible for a retry.
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {/* Tabs: Incoming lands in Phase 4 */}
      <div className="flex gap-2 border-b border-cinema-border mb-6">
        <button className="px-4 py-2 text-sm font-medium text-cinema-gold border-b-2 border-cinema-gold -mb-px">
          Friends
        </button>
        <button
          disabled
          title="Coming soon"
          className="px-4 py-2 text-sm font-medium text-cinema-muted opacity-50 cursor-not-allowed"
        >
          Incoming
        </button>
      </div>

      {items.length === 0 && !hasMore ? (
        <div className="text-center py-16">
          <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold text-cinema-cream mb-2">
            Your feed starts with people
          </h2>
          <p className="text-sm text-cinema-muted mb-6">
            Follow members to see their reviews, watchlist adds, and lists here.
          </p>
          <Link
            href="/members"
            className="inline-block px-5 py-2.5 rounded-lg bg-cinema-gold text-cinema-dark text-sm font-semibold hover:bg-cinema-gold/90 transition-colors"
          >
            Find members
          </Link>
        </div>
      ) : (
        <>
          <ul>
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 py-3 border-b border-cinema-border/50 last:border-b-0"
              >
                <Avatar user={item.actor} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-cinema-cream">
                    <FeedSentence item={item} />
                  </p>
                  <p className="text-xs text-cinema-muted mt-0.5">{timeAgo(item.createdAt)}</p>
                </div>
                {item.film && item.type !== 'follow' && <PosterThumb film={item.film} />}
              </li>
            ))}
          </ul>

          {hasMore && (
            <div className="flex justify-center mt-8">
              <button
                onClick={handleLoadMore}
                disabled={loading}
                className="text-sm font-medium px-6 py-2.5 rounded-lg border border-cinema-border text-cinema-cream hover:border-cinema-gold/50 hover:text-cinema-gold transition-colors disabled:opacity-50"
              >
                {loading ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
