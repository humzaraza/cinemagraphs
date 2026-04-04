'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useParams } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import ShareModal from '@/components/ShareModal'
import EditProfileModal from '@/components/EditProfileModal'

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
    email: string
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

type Tab = 'reviews' | 'graphs' | 'reactions' | 'watchlist'

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
        <span className="text-sm">
          <span className="font-semibold text-cinema-cream">{user.followerCount}</span>{' '}
          <span className="text-cinema-muted">followers</span>
        </span>
        <span className="text-sm">
          <span className="font-semibold text-cinema-cream">{user.followingCount}</span>{' '}
          <span className="text-cinema-muted">following</span>
        </span>
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
        <StatBox label="Films Reacted" value={stats.filmsReacted} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-cinema-border overflow-x-auto">
        {([
          ['reviews', `All Reviews (${reviews.length})`],
          ['graphs', `My Graphs (${graphReviews.length})`],
          ['reactions', `Live Reactions (${reactionsByFilm.size})`],
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
      {tab === 'reactions' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from(reactionsByFilm.values()).map(({ film, reactions: filmReactions }) => (
            <ReactionCard key={film.id} film={film} reactions={filmReactions} />
          ))}
          {reactionsByFilm.size === 0 && (
            <p className="text-cinema-muted col-span-2 text-center py-8">No live reactions yet.</p>
          )}
        </div>
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
    </div>
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
              src={`https://image.tmdb.org/t/p/w154${film.posterUrl}`}
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
              src={`https://image.tmdb.org/t/p/w92${film.posterUrl}`}
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
