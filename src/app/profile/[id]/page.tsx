'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useParams } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import ShareModal from '@/components/ShareModal'
import EditProfileModal from '@/components/EditProfileModal'
import NewListModal from '@/components/NewListModal'

interface FilmData {
  id: string
  title: string
  posterUrl: string | null
  releaseDate: string | null
  director: string | null
  runtime: number | null
  genres?: string[]
  sentimentGraph: { overallScore: number; dataPoints: DataPoint[] } | null
}

interface DataPoint {
  label: string
  score: number
  timeStart: number
  timeEnd: number
  timeMidpoint: number
}

interface ReviewData {
  id: string
  overallRating: number
  beginning: string | null
  middle: string | null
  ending: string | null
  otherThoughts: string | null
  combinedText: string | null
  beatRatings: Record<string, number> | null
  sentiment: number | null
  createdAt: string
  film: FilmData
}

interface ReactionData {
  id: string
  filmId: string
  reaction: string
  score: number
  sessionTimestamp: number
  createdAt: string
  film: { id: string; title: string; posterUrl: string | null }
}

interface ProfileData {
  user: {
    id: string
    name: string | null
    rawName: string | null
    username: string | null
    image: string | null
    bio: string | null
    createdAt: string
    followerCount: number
    followingCount: number
  }
  stats: { totalReviews: number; avgRating: number; graphsContributed: number; filmsReacted: number }
  reviews: ReviewData[]
  reactions: ReactionData[]
  watchlist: FilmData[]
}

interface ListPreviewPoster {
  id: string
  posterUrl: string | null
}

interface ListCardData {
  id: string
  name: string
  genreTag: string | null
  isPublic: boolean
  filmCount: number
  previewPosters: ListPreviewPoster[]
  createdAt: string
  updatedAt: string
}

type Tab = 'reviews' | 'graphs' | 'reactions' | 'lists' | 'watchlist'

export default function ProfilePage() {
  const params = useParams()
  const { data: session } = useSession()
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('reviews')
  const [shareReview, setShareReview] = useState<ReviewData | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [isFollowing, setIsFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [lists, setLists] = useState<ListCardData[] | null>(null)
  const [newListOpen, setNewListOpen] = useState(false)
  const [followModal, setFollowModal] = useState<'followers' | 'following' | null>(null)

  const userId = params.id as string
  const isOwnProfile = session?.user?.id === userId

  const fetchProfile = useCallback(() => {
    fetch(`/api/users/${userId}`)
      .then((r) => {
        if (!r.ok) throw new Error('Profile not found')
        return r.json()
      })
      .then(setProfile)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [userId])

  useEffect(() => {
    fetchProfile()
  }, [fetchProfile])

  const fetchLists = useCallback(() => {
    fetch(`/api/users/${userId}/lists`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Failed to load lists'))))
      .then((data) => setLists(data.lists as ListCardData[]))
      .catch(() => setLists([]))
  }, [userId])

  useEffect(() => {
    if (tab === 'lists' && lists === null) {
      fetchLists()
    }
  }, [tab, lists, fetchLists])

  // Check follow status
  useEffect(() => {
    if (!session?.user?.id || isOwnProfile) return
    fetch(`/api/users/${userId}/follow`)
      .then((r) => r.json())
      .then((data) => setIsFollowing(data.following))
      .catch(() => {})
  }, [session?.user?.id, userId, isOwnProfile])

  const handleFollow = async () => {
    if (!session?.user?.id) return
    setFollowLoading(true)
    try {
      const res = await fetch(`/api/users/${userId}/follow`, {
        method: isFollowing ? 'DELETE' : 'POST',
      })
      if (res.ok) {
        setIsFollowing(!isFollowing)
        // Update counts locally
        if (profile) {
          setProfile({
            ...profile,
            user: {
              ...profile.user,
              followerCount: profile.user.followerCount + (isFollowing ? -1 : 1),
            },
          })
        }
      }
    } catch {
      // ignore
    } finally {
      setFollowLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="animate-pulse space-y-6">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-cinema-card" />
            <div className="space-y-2">
              <div className="h-6 w-40 bg-cinema-card rounded" />
              <div className="h-4 w-24 bg-cinema-card rounded" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (error || !profile) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-12 text-center">
        <p className="text-cinema-muted text-lg">{error || 'Profile not found'}</p>
      </div>
    )
  }

  const { user, stats, reviews, reactions, watchlist } = profile
  const displayName = user.name || 'User'
  const initial = displayName[0].toUpperCase()
  const memberSince = new Date(user.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })

  const graphReviews = reviews.filter((r) => r.beatRatings !== null)

  // Group reactions by film
  const reactionsByFilm = new Map<string, { film: ReactionData['film']; reactions: ReactionData[] }>()
  for (const r of reactions) {
    if (!reactionsByFilm.has(r.filmId)) {
      reactionsByFilm.set(r.filmId, { film: r.film, reactions: [] })
    }
    reactionsByFilm.get(r.filmId)!.reactions.push(r)
  }

  const displayReviews = tab === 'graphs' ? graphReviews : reviews

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      {/* Profile Header */}
      <div className="flex items-center gap-4 mb-2">
        {user.image ? (
          <Image
            src={user.image}
            alt={displayName}
            width={64}
            height={64}
            className="rounded-full"
          />
        ) : (
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold"
            style={{
              background: 'linear-gradient(135deg, #C8A951, #a08530)',
              color: '#0D0D1A',
            }}
          >
            {initial}
          </div>
        )}
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="font-[family-name:var(--font-playfair)] text-2xl font-bold text-cinema-cream">
              {displayName}
            </h1>
            {isOwnProfile && (
              <button
                onClick={() => setEditOpen(true)}
                className="text-xs px-3 py-1 rounded-full border border-cinema-border text-cinema-muted hover:border-cinema-gold/50 hover:text-cinema-cream transition-colors"
              >
                Edit Profile
              </button>
            )}
            {!isOwnProfile && session?.user?.id && (
              <button
                onClick={handleFollow}
                disabled={followLoading}
                className={`text-xs px-4 py-1.5 rounded-full font-semibold transition-colors ${
                  isFollowing
                    ? 'bg-cinema-card border border-cinema-border text-cinema-cream hover:border-red-500/50 hover:text-red-400'
                    : 'bg-cinema-gold text-cinema-dark hover:bg-cinema-gold/90'
                }`}
              >
                {followLoading ? '...' : isFollowing ? 'Following' : 'Follow'}
              </button>
            )}
          </div>
          {user.username && (
            <p className="text-sm text-cinema-muted">@{user.username}</p>
          )}
          <p className="text-sm text-cinema-muted">Member since {memberSince}</p>
        </div>
      </div>

      {/* Bio */}
      {user.bio && (
        <p className="text-sm text-cinema-cream/70 mb-4 ml-20">{user.bio}</p>
      )}

      {/* Follower/Following counts */}
      <div className="flex gap-4 mb-6 ml-20">
        <button
          onClick={() => setFollowModal('followers')}
          className="text-sm cursor-pointer hover:opacity-80 transition-opacity"
        >
          <span className="font-semibold text-cinema-cream">{user.followerCount}</span>{' '}
          <span className="text-cinema-muted">followers</span>
        </button>
        <button
          onClick={() => setFollowModal('following')}
          className="text-sm cursor-pointer hover:opacity-80 transition-opacity"
        >
          <span className="font-semibold text-cinema-cream">{user.followingCount}</span>{' '}
          <span className="text-cinema-muted">following</span>
        </button>
      </div>

      {/* Stats Row */}
      <div
        className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8 p-4 rounded-lg"
        style={{
          background: 'linear-gradient(135deg, rgba(200,169,81,0.1), rgba(200,169,81,0.03))',
          border: '1px solid rgba(200,169,81,0.15)',
        }}
      >
        <StatBox label="Reviews" value={stats.totalReviews} />
        <StatBox label="Avg Rating" value={stats.avgRating.toFixed(1)} />
        <StatBox label="Graphs" value={stats.graphsContributed} />
        {/* <StatBox label="Films Reacted" value={stats.filmsReacted} /> */}{/* hidden — re-enable when ready */}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-cinema-border overflow-x-auto">
        {([
          ['reviews', `All Reviews (${reviews.length})`],
          ['graphs', `My Graphs (${graphReviews.length})`],
          // ['reactions', `Live Reactions (${reactionsByFilm.size})`], // hidden — re-enable when ready
          ['lists', 'Lists'],
          ['watchlist', `Watchlist (${watchlist.length})`],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              tab === key
                ? 'border-cinema-gold text-cinema-gold'
                : 'border-transparent text-cinema-muted hover:text-cinema-cream'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {/* Live Reactions tab content hidden — re-enable when ready */}
      {tab === 'lists' ? (
        <ListsTabContent
          lists={lists}
          isOwnProfile={isOwnProfile}
          onNewList={() => setNewListOpen(true)}
        />
      ) : tab === 'watchlist' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {watchlist.map((film) => (
            <WatchlistCard key={film.id} film={film} />
          ))}
          {watchlist.length === 0 && (
            <p className="text-cinema-muted col-span-full text-center py-8">
              No films in watchlist yet.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {displayReviews.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              isOwn={isOwnProfile}
              onShare={() => setShareReview(review)}
            />
          ))}
          {displayReviews.length === 0 && (
            <p className="text-cinema-muted col-span-2 text-center py-8">
              {tab === 'graphs' ? 'No graph contributions yet.' : 'No reviews yet.'}
            </p>
          )}
        </div>
      )}

      {/* Share Modal */}
      {shareReview && (
        <ShareModal
          reviewId={shareReview.id}
          filmTitle={shareReview.film.title}
          onClose={() => setShareReview(null)}
        />
      )}

      {/* Edit Profile Modal */}
      {editOpen && (
        <EditProfileModal
          currentName={user.rawName || ''}
          currentUsername={user.username || ''}
          currentBio={user.bio || ''}
          currentImage={user.image || ''}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false)
            fetchProfile()
          }}
        />
      )}

      {/* New List Modal */}
      {newListOpen && (
        <NewListModal
          onClose={() => setNewListOpen(false)}
          onCreated={() => {
            setNewListOpen(false)
            setLists(null)
            fetchLists()
          }}
        />
      )}

      {/* Followers/Following Modal */}
      {followModal && (
        <FollowModal
          userId={userId}
          initialTab={followModal}
          currentUserId={session?.user?.id ?? null}
          onClose={() => setFollowModal(null)}
        />
      )}
    </div>
  )
}

function ListsTabContent({
  lists,
  isOwnProfile,
  onNewList,
}: {
  lists: ListCardData[] | null
  isOwnProfile: boolean
  onNewList: () => void
}) {
  if (lists === null) {
    return (
      <div className="text-center py-8 text-cinema-muted text-sm">Loading lists…</div>
    )
  }

  if (lists.length === 0) {
    return (
      <div>
        {isOwnProfile && (
          <div className="flex items-center justify-end mb-4">
            <button
              onClick={onNewList}
              className="flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-md transition-colors border hover:bg-cinema-gold/10"
              style={{
                color: '#C8A951',
                borderColor: 'rgba(200,169,81,0.4)',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New list
            </button>
          </div>
        )}
        <div className="flex flex-col items-center justify-center text-center py-16">
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center mb-4"
            style={{
              border: '1px dashed rgba(200,169,81,0.25)',
              background: 'rgba(245,240,225,0.02)',
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#C8A951" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </div>
          <h3 className="font-[family-name:var(--font-playfair)] text-base text-cinema-cream mb-1">
            No lists yet
          </h3>
          <p className="text-xs text-cinema-muted mb-5 max-w-xs leading-relaxed">
            {isOwnProfile
              ? 'Create a list to curate your favorite films and compare their sentiment arcs.'
              : 'This user has not created any public lists.'}
          </p>
          {isOwnProfile && (
            <button
              onClick={onNewList}
              className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-md transition-colors"
              style={{
                color: '#C8A951',
                border: '1px solid rgba(200,169,81,0.4)',
                background: 'rgba(200,169,81,0.08)',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Create your first list
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-cinema-muted">
          {lists.length} {lists.length === 1 ? 'list' : 'lists'}
        </span>
        {isOwnProfile && (
          <button
            onClick={onNewList}
            className="flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-md transition-colors hover:bg-cinema-gold/10"
            style={{
              color: '#C8A951',
              border: '1px solid rgba(200,169,81,0.4)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New list
          </button>
        )}
      </div>

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
      >
        {lists.map((list) => (
          <ListCard key={list.id} list={list} />
        ))}
      </div>
    </div>
  )
}

function formatRelativeUpdated(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day
  if (diffMs < minute) return 'just now'
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`
  if (diffMs < week) {
    const d = Math.floor(diffMs / day)
    return d === 1 ? '1 day ago' : `${d} days ago`
  }
  if (diffMs < 30 * day) {
    const w = Math.floor(diffMs / week)
    return w === 1 ? '1 week ago' : `${w} weeks ago`
  }
  const months = Math.floor(diffMs / (30 * day))
  return months === 1 ? '1 month ago' : `${months} months ago`
}

function ListCard({ list }: { list: ListCardData }) {
  const posters = list.previewPosters.slice(0, 5)
  const placeholders = Math.max(0, 5 - posters.length)
  const filmLabel = `${list.filmCount} ${list.filmCount === 1 ? 'film' : 'films'}`

  return (
    <Link
      href={`/lists/${list.id}`}
      className="group block rounded-xl p-4 transition-all duration-200 hover:-translate-y-0.5"
      style={{
        background: 'rgba(245,240,225,0.02)',
        border: '1px solid rgba(200,169,81,0.06)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(200,169,81,0.2)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(200,169,81,0.06)'
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3
          className="font-[family-name:var(--font-playfair)] text-cinema-cream leading-tight"
          style={{ fontSize: '15px', fontWeight: 500 }}
        >
          {list.name}
        </h3>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-cinema-muted">{filmLabel}</span>
          <span
            className="uppercase px-1.5 py-0.5 rounded font-semibold tracking-wide"
            style={{
              fontSize: '9px',
              color: list.isPublic ? '#2DD4A8' : 'rgba(245,240,225,0.45)',
              border: list.isPublic ? '1px solid rgba(45,212,168,0.35)' : '1px solid rgba(245,240,225,0.12)',
            }}
          >
            {list.isPublic ? 'Public' : 'Private'}
          </span>
        </div>
      </div>

      {list.genreTag && (
        <div className="mb-3">
          <span
            className="inline-block px-2 py-0.5 rounded-full font-semibold"
            style={{
              fontSize: '10px',
              color: '#C8A951',
              background: 'rgba(200,169,81,0.12)',
              border: '1px solid rgba(200,169,81,0.25)',
            }}
          >
            {list.genreTag}
          </span>
        </div>
      )}

      <div className="flex gap-1.5 mt-1">
        {posters.map((p) => (
          <div
            key={p.id}
            className="overflow-hidden bg-cinema-darker"
            style={{ width: 38, height: 56, borderRadius: 4 }}
          >
            {p.posterUrl ? (
              <Image
                src={`https://image.tmdb.org/t/p/w92${p.posterUrl}`}
                alt=""
                width={38}
                height={56}
                unoptimized
                className="w-full h-full object-cover"
              />
            ) : null}
          </div>
        ))}
        {Array.from({ length: placeholders }).map((_, i) => (
          <div
            key={`placeholder-${i}`}
            style={{
              width: 38,
              height: 56,
              borderRadius: 4,
              background: 'rgba(245,240,225,0.03)',
              border: '1px dashed rgba(245,240,225,0.06)',
            }}
          />
        ))}
      </div>

      <p className="text-[10px] text-cinema-muted/60 mt-3">
        Updated {formatRelativeUpdated(list.updatedAt)}
      </p>
    </Link>
  )
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center">
      <p className="font-[family-name:var(--font-bebas)] text-2xl text-cinema-gold">{value}</p>
      <p className="text-xs text-cinema-muted uppercase tracking-wider">{label}</p>
    </div>
  )
}

function WatchlistCard({ film }: { film: FilmData }) {
  return (
    <Link href={`/films/${film.id}`} className="group block">
      <div className="rounded-lg overflow-hidden bg-cinema-darker border border-cinema-border group-hover:border-cinema-gold/50 transition-all duration-300">
        <div className="relative aspect-[2/3]">
          {film.posterUrl ? (
            <Image
              src={`https://image.tmdb.org/t/p/w342${film.posterUrl}`}
              alt={film.title}
              fill
              unoptimized
              className="object-cover group-hover:scale-105 transition-transform duration-500"
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-cinema-muted text-xs">
              No Poster
            </div>
          )}
          {film.sentimentGraph && (
            <div className="absolute top-2 right-2 bg-cinema-dark/90 backdrop-blur-sm rounded px-2 py-1">
              <span className="font-[family-name:var(--font-bebas)] text-lg text-cinema-gold">
                {film.sentimentGraph.overallScore.toFixed(1)}
              </span>
            </div>
          )}
        </div>
        <div className="px-3 py-2.5" style={{ backgroundColor: '#13131f' }}>
          <h3 className="font-[family-name:var(--font-playfair)] text-sm font-semibold leading-tight text-white truncate">
            {film.title}
          </h3>
          {film.releaseDate && (
            <span className="text-xs text-cinema-muted">
              {new Date(film.releaseDate).getFullYear()}
            </span>
          )}
        </div>
      </div>
    </Link>
  )
}

function ReviewCard({
  review,
  isOwn,
  onShare,
}: {
  review: ReviewData
  isOwn: boolean
  onShare: () => void
}) {
  const { film } = review
  const ratingColor = review.overallRating >= 7 ? '#C8A951' : '#ef4444'
  const hasBeatRatings = review.beatRatings !== null

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div className="flex gap-3 p-3">
        {/* Poster */}
        <Link href={`/films/${film.id}`} className="shrink-0">
          {film.posterUrl ? (
            <Image
              src={`https://image.tmdb.org/t/p/w185${film.posterUrl}`}
              alt={film.title}
              width={80}
              height={120}
              unoptimized
              className="rounded object-cover"
            />
          ) : (
            <div className="w-20 h-30 bg-cinema-card rounded flex items-center justify-center text-cinema-muted text-xs">
              No poster
            </div>
          )}
        </Link>

        <div className="flex-1 min-w-0">
          {/* Title + Rating */}
          <div className="flex items-start justify-between gap-2 mb-1">
            <Link href={`/films/${film.id}`} className="hover:text-cinema-gold transition-colors">
              <h3 className="font-[family-name:var(--font-playfair)] text-sm font-bold text-cinema-cream leading-tight">
                {film.title}
              </h3>
            </Link>
            <span
              className="font-[family-name:var(--font-bebas)] text-xl shrink-0"
              style={{ color: ratingColor }}
            >
              {review.overallRating.toFixed(1)}
            </span>
          </div>

          {/* Mini Sentiment Graph */}
          {hasBeatRatings && film.sentimentGraph && (
            <MiniGraph
              dataPoints={film.sentimentGraph.dataPoints}
              beatRatings={review.beatRatings!}
            />
          )}

          {/* Combined Text Preview */}
          {review.combinedText && (
            <p
              className="text-xs mt-1.5 line-clamp-2"
              style={{ color: 'rgba(255,255,255,0.5)' }}
            >
              {review.combinedText}
            </p>
          )}

          {/* Badges + Share */}
          <div className="flex items-center gap-2 mt-2">
            {hasBeatRatings && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase"
                style={{ backgroundColor: 'rgba(200,169,81,0.2)', color: '#C8A951' }}
              >
                Graphed
              </span>
            )}
            {!hasBeatRatings && review.combinedText && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase"
                style={{ backgroundColor: 'rgba(45,212,168,0.2)', color: '#2DD4A8' }}
              >
                Reviewed
              </span>
            )}
            {isOwn && (
              <button
                onClick={onShare}
                className="ml-auto flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md transition-colors hover:bg-cinema-gold/10"
                style={{
                  color: '#c8a96e',
                  border: '1px solid rgba(200,169,110,0.4)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
                Share
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function MiniGraph({
  dataPoints,
  beatRatings,
}: {
  dataPoints: DataPoint[]
  beatRatings: Record<string, number>
}) {
  const width = 200
  const height = 40
  const padding = 2

  // Build gold line from external data
  const goldPath = dataPoints
    .map((dp, i) => {
      const x = padding + (i / Math.max(dataPoints.length - 1, 1)) * (width - padding * 2)
      const y = height - padding - ((dp.score - 1) / 9) * (height - padding * 2)
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    })
    .join(' ')

  // Build teal line from user beat ratings
  const matchedBeats = dataPoints
    .map((dp, i) => {
      const rating = beatRatings[dp.label]
      if (rating === undefined) return null
      const x = padding + (i / Math.max(dataPoints.length - 1, 1)) * (width - padding * 2)
      const y = height - padding - ((rating - 1) / 9) * (height - padding * 2)
      return { x, y }
    })
    .filter(Boolean) as { x: number; y: number }[]

  const tealPath = matchedBeats
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`)
    .join(' ')

  return (
    <svg width={width} height={height} className="w-full" viewBox={`0 0 ${width} ${height}`}>
      {goldPath && (
        <path d={goldPath} fill="none" stroke="#C8A951" strokeWidth="1.5" opacity="0.6" />
      )}
      {tealPath && (
        <path
          d={tealPath}
          fill="none"
          stroke="#2DD4A8"
          strokeWidth="1.5"
          strokeDasharray="3 2"
          opacity="0.8"
        />
      )}
    </svg>
  )
}

function ReactionCard({
  film,
  reactions,
}: {
  film: { id: string; title: string; posterUrl: string | null }
  reactions: ReactionData[]
}) {
  const emojiMap: Record<string, string> = {
    up: '\u{1F44D}',
    down: '\u{1F44E}',
    wow: '\u{1F929}',
    shock: '\u{1F631}',
    funny: '\u{1F602}',
  }

  const counts: Record<string, number> = {}
  for (const r of reactions) {
    counts[r.reaction] = (counts[r.reaction] || 0) + 1
  }

  const lastScore = reactions[reactions.length - 1]?.score ?? 5

  return (
    <div
      className="rounded-lg p-3"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div className="flex items-center gap-3 mb-2">
        {film.posterUrl && (
          <Link href={`/films/${film.id}`}>
            <Image
              src={`https://image.tmdb.org/t/p/w185${film.posterUrl}`}
              alt={film.title}
              width={40}
              height={60}
              unoptimized
              className="rounded object-cover"
            />
          </Link>
        )}
        <div className="flex-1 min-w-0">
          <Link href={`/films/${film.id}`} className="hover:text-cinema-gold transition-colors">
            <h3 className="text-sm font-bold text-cinema-cream truncate">{film.title}</h3>
          </Link>
          <p className="text-xs text-cinema-muted">{reactions.length} reactions</p>
        </div>
        <span
          className="font-[family-name:var(--font-bebas)] text-xl"
          style={{ color: lastScore >= 7 ? '#C8A951' : '#ef4444' }}
        >
          {lastScore.toFixed(1)}
        </span>
      </div>
      <div className="flex gap-2 flex-wrap">
        {Object.entries(counts).map(([key, count]) => (
          <span key={key} className="text-xs text-cinema-muted">
            {emojiMap[key] || key} {count}
          </span>
        ))}
      </div>
      <span
        className="inline-block text-[10px] px-1.5 py-0.5 rounded font-bold uppercase mt-2"
        style={{ backgroundColor: 'rgba(45,212,168,0.2)', color: '#2DD4A8' }}
      >
        Reacted
      </span>
    </div>
  )
}

interface FollowUser {
  id: string
  name: string
  username: string | null
  image: string | null
  isFollowing: boolean
}

function FollowModal({
  userId,
  initialTab,
  currentUserId,
  onClose,
}: {
  userId: string
  initialTab: 'followers' | 'following'
  currentUserId: string | null
  onClose: () => void
}) {
  const [tab, setTab] = useState<'followers' | 'following'>(initialTab)
  const [users, setUsers] = useState<FollowUser[]>([])
  const [loading, setLoading] = useState(true)
  const [followingState, setFollowingState] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setLoading(true)
    setUsers([])
    const endpoint = tab === 'followers'
      ? `/api/users/${userId}/followers`
      : `/api/users/${userId}/following`
    fetch(endpoint)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((data) => {
        setUsers(data.users)
        const state: Record<string, boolean> = {}
        for (const u of data.users) {
          state[u.id] = u.isFollowing
        }
        setFollowingState(state)
      })
      .catch(() => setUsers([]))
      .finally(() => setLoading(false))
  }, [tab, userId])

  const handleToggleFollow = async (targetId: string) => {
    if (!currentUserId) return
    const wasFollowing = followingState[targetId]
    setFollowingState((prev) => ({ ...prev, [targetId]: !wasFollowing }))
    try {
      const res = await fetch(`/api/users/${targetId}/follow`, {
        method: wasFollowing ? 'DELETE' : 'POST',
      })
      if (!res.ok) {
        setFollowingState((prev) => ({ ...prev, [targetId]: wasFollowing }))
      }
    } catch {
      setFollowingState((prev) => ({ ...prev, [targetId]: wasFollowing }))
    }
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-md mx-4 rounded-xl overflow-hidden flex flex-col"
        style={{
          backgroundColor: '#12121e',
          border: '1px solid rgba(200,169,81,0.15)',
          maxHeight: '70vh',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-0">
          <div className="flex gap-0">
            {(['followers', 'following'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${
                  tab === t
                    ? 'border-cinema-gold text-cinema-gold'
                    : 'border-transparent text-cinema-muted hover:text-cinema-cream'
                }`}
              >
                {t === 'followers' ? 'Followers' : 'Following'}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 text-cinema-muted hover:text-cinema-cream transition-colors"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Divider */}
        <div className="border-b border-cinema-border" />

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 border-2 border-cinema-gold/30 border-t-cinema-gold rounded-full animate-spin" />
            </div>
          ) : users.length === 0 ? (
            <p className="text-center text-cinema-muted text-sm py-10">
              {tab === 'followers' ? 'No followers yet' : 'Not following anyone yet'}
            </p>
          ) : (
            <div className="space-y-1">
              {users.map((u) => {
                const initial = (u.name || '?')[0].toUpperCase()
                const isCurrentUser = u.id === currentUserId
                const isFollowed = followingState[u.id]

                return (
                  <div key={u.id} className="flex items-center gap-3 py-2">
                    <Link href={`/profile/${u.id}`} onClick={onClose} className="shrink-0">
                      {u.image ? (
                        <Image
                          src={u.image}
                          alt={u.name}
                          width={32}
                          height={32}
                          className="rounded-full"
                        />
                      ) : (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
                          style={{
                            background: 'linear-gradient(135deg, #C8A951, #a08530)',
                            color: '#0D0D1A',
                          }}
                        >
                          {initial}
                        </div>
                      )}
                    </Link>
                    <Link
                      href={`/profile/${u.id}`}
                      onClick={onClose}
                      className="flex-1 min-w-0 hover:opacity-80 transition-opacity"
                    >
                      <p className="text-sm font-semibold text-cinema-cream truncate">
                        {u.name}
                      </p>
                      {u.username && (
                        <p className="text-xs text-cinema-muted truncate">@{u.username}</p>
                      )}
                    </Link>
                    {!isCurrentUser && currentUserId && (
                      <button
                        onClick={() => handleToggleFollow(u.id)}
                        className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors ${
                          isFollowed
                            ? 'bg-cinema-gold text-cinema-dark hover:bg-red-500/80 hover:text-white'
                            : 'border border-cinema-border text-cinema-cream hover:border-cinema-gold/50'
                        }`}
                        onMouseEnter={(e) => {
                          if (isFollowed) e.currentTarget.textContent = 'Unfollow'
                        }}
                        onMouseLeave={(e) => {
                          if (isFollowed) e.currentTarget.textContent = 'Following'
                        }}
                      >
                        {isFollowed ? 'Following' : 'Follow'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
