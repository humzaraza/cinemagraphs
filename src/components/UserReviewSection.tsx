'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSession, signIn } from 'next-auth/react'
import Image from 'next/image'
import Link from 'next/link'

interface BeatInfo {
  label: string
  score: number
}

interface ReviewData {
  id: string
  overallRating: number
  combinedText: string | null
  createdAt: string
  user: { id: string; name: string | null; image: string | null }
}

interface Summary {
  avgRating: number | null
  totalReviews: number
  distribution: { score: number; count: number }[]
  sectionCounts: { beginning: number; middle: number; ending: number }
}

interface Props {
  filmId: string
  hasGraph: boolean
  beats: BeatInfo[]
}

/** Select up to 8 beats: peak, lowest, first, last, + 4 evenly distributed */
function selectBeats(beats: BeatInfo[]): { beat: BeatInfo; tag: 'peak' | 'lowest' | null }[] {
  if (beats.length <= 8) {
    const peakIdx = beats.reduce((best, b, i) => (b.score > beats[best].score ? i : best), 0)
    const lowIdx = beats.reduce((best, b, i) => (b.score < beats[best].score ? i : best), 0)
    return beats.map((b, i) => ({
      beat: b,
      tag: i === peakIdx ? 'peak' : i === lowIdx ? 'lowest' : null,
    }))
  }

  const peakIdx = beats.reduce((best, b, i) => (b.score > beats[best].score ? i : best), 0)
  const lowIdx = beats.reduce((best, b, i) => (b.score < beats[best].score ? i : best), 0)

  const selectedIndices = new Set<number>()
  selectedIndices.add(0) // first
  selectedIndices.add(beats.length - 1) // last
  selectedIndices.add(peakIdx)
  selectedIndices.add(lowIdx)

  // Fill remaining slots with evenly distributed points
  const remaining = beats
    .map((_, i) => i)
    .filter((i) => !selectedIndices.has(i))

  const needed = 8 - selectedIndices.size
  if (needed > 0 && remaining.length > 0) {
    const step = remaining.length / needed
    for (let j = 0; j < needed; j++) {
      selectedIndices.add(remaining[Math.round(j * step)])
    }
  }

  const sorted = Array.from(selectedIndices).sort((a, b) => a - b)
  return sorted.map((i) => ({
    beat: beats[i],
    tag: i === peakIdx ? 'peak' : i === lowIdx ? 'lowest' : null,
  }))
}

interface ExistingReview {
  id: string
  overallRating: number
  beginning: string | null
  middle: string | null
  ending: string | null
  otherThoughts: string | null
  combinedText: string | null
  beatRatings: Record<string, number> | null
  status: string
  createdAt: string
  user: { id: string; name: string | null; image: string | null }
}

export default function UserReviewSection({ filmId, hasGraph, beats }: Props) {
  const { data: session } = useSession()
  const [overallRating, setOverallRating] = useState(5.5)
  const [beatRatings, setBeatRatings] = useState<Record<string, number>>({})
  const [beginning, setBeginning] = useState('')
  const [middle, setMiddle] = useState('')
  const [ending, setEnding] = useState('')
  const [otherThoughts, setOtherThoughts] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Existing review state
  const [myReview, setMyReview] = useState<ExistingReview | null>(null)
  const [editing, setEditing] = useState(false)

  // Community data
  const [reviews, setReviews] = useState<ReviewData[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(true)

  const selectedBeats = useMemo(() => selectBeats(beats), [beats])

  // Initialize beat ratings
  useEffect(() => {
    if (hasGraph && selectedBeats.length > 0 && !myReview && !editing) {
      const initial: Record<string, number> = {}
      for (const { beat } of selectedBeats) {
        initial[beat.label] = 5.5
      }
      setBeatRatings(initial)
    }
  }, [hasGraph, selectedBeats, myReview, editing])

  const fetchReviews = useCallback(async (p: number) => {
    try {
      const res = await fetch(`/api/films/${filmId}/reviews?page=${p}`)
      if (res.ok) {
        const data = await res.json()
        if (p === 1) {
          setReviews(data.reviews)
        } else {
          setReviews((prev) => [...prev, ...data.reviews])
        }
        setSummary(data.summary)
        setTotalPages(data.totalPages)
        // Set existing review if present
        if (data.myReview && p === 1) {
          setMyReview(data.myReview)
        }
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [filmId])

  useEffect(() => {
    fetchReviews(1)
  }, [fetchReviews])

  function startEditing() {
    if (!myReview) return
    setOverallRating(myReview.overallRating)
    setBeginning(myReview.beginning || '')
    setMiddle(myReview.middle || '')
    setEnding(myReview.ending || '')
    setOtherThoughts(myReview.otherThoughts || '')
    if (myReview.beatRatings) {
      setBeatRatings(myReview.beatRatings)
    }
    setEditing(true)
    setSubmitted(false)
  }

  async function handleSubmit() {
    if (!session) {
      signIn()
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/films/${filmId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overallRating,
          beginning: beginning.trim() || undefined,
          middle: middle.trim() || undefined,
          ending: ending.trim() || undefined,
          otherThoughts: otherThoughts.trim() || undefined,
          beatRatings: hasGraph ? beatRatings : undefined,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to submit review')
        return
      }

      setSubmitted(true)
      setEditing(false)
      fetchReviews(1)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const maxCount = summary?.distribution
    ? Math.max(...summary.distribution.map((d) => d.count), 1)
    : 1

  return (
    <div className="space-y-6">
      {/* Review Form */}
      <div className="bg-cinema-darker rounded-lg border border-cinema-border p-6">
        {!session && (
          <div className="bg-cinema-gold/10 border border-cinema-gold/20 rounded-lg p-3 mb-4 text-center">
            <span className="text-sm text-cinema-gold">
              Sign in or create a free account to contribute your review
            </span>
          </div>
        )}

        {/* Show existing review if user already reviewed and not editing */}
        {myReview && !editing && !submitted ? (
          <div className="space-y-4">
            <h3 className="font-[family-name:var(--font-playfair)] text-lg text-cinema-cream">
              Your Review
            </h3>
            <div className="bg-cinema-card border border-cinema-border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-cinema-muted">
                  Submitted {new Date(myReview.createdAt).toLocaleDateString()}
                </span>
                <div className="flex items-center gap-2">
                  <span
                    className="text-xs px-2 py-0.5 rounded"
                    style={{
                      backgroundColor:
                        myReview.status === 'approved'
                          ? 'rgba(45,212,168,0.15)'
                          : myReview.status === 'flagged'
                            ? 'rgba(200,169,81,0.15)'
                            : 'rgba(239,68,68,0.15)',
                      color:
                        myReview.status === 'approved'
                          ? '#2DD4A8'
                          : myReview.status === 'flagged'
                            ? '#C8A951'
                            : '#ef4444',
                    }}
                  >
                    {myReview.status === 'approved' ? 'Live' : myReview.status === 'flagged' ? 'Under review' : 'Rejected'}
                  </span>
                  <span
                    className="text-sm font-bold px-2 py-0.5 rounded"
                    style={{
                      backgroundColor:
                        myReview.overallRating >= 8
                          ? '#2DD4A8'
                          : myReview.overallRating >= 6
                            ? '#C8A951'
                            : '#ef4444',
                      color: '#1a1a2e',
                    }}
                  >
                    {myReview.overallRating.toFixed(1)}
                  </span>
                </div>
              </div>
              {myReview.combinedText && (
                <p className="text-sm text-cinema-cream/80 leading-relaxed">{myReview.combinedText}</p>
              )}
              {myReview.beatRatings && Object.keys(myReview.beatRatings).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(myReview.beatRatings).map(([label, score]) => (
                    <span
                      key={label}
                      className="text-[10px] px-2 py-0.5 rounded-full border"
                      style={{
                        borderColor: score >= 8 ? '#2DD4A840' : score >= 6 ? '#C8A95140' : '#ef444440',
                        color: score >= 8 ? '#2DD4A8' : score >= 6 ? '#C8A951' : '#ef4444',
                      }}
                    >
                      {label}: {score.toFixed(1)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={startEditing}
              className="text-sm text-cinema-gold hover:text-cinema-gold/80 transition-colors border border-cinema-gold/30 px-4 py-2 rounded-lg hover:bg-cinema-gold/10"
            >
              Edit your review
            </button>
          </div>
        ) : submitted && !editing ? (
          <div className="text-center py-8">
            <div className="text-3xl mb-2">✓</div>
            <p className="text-cinema-cream text-lg font-medium">Review submitted!</p>
            <p className="text-cinema-muted text-sm mt-1">
              Your review is now live. It may be flagged for review if our system detects anything unusual.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            <h3 className="font-[family-name:var(--font-playfair)] text-lg text-cinema-cream">
              {editing ? 'Edit your Review' : 'Write a Review'}
            </h3>

            {!hasGraph && (
              <div className="bg-[#2DD4A8]/10 border border-[#2DD4A8]/20 rounded-lg p-3">
                <span className="text-sm text-[#2DD4A8]">
                  Help build this film&apos;s graph — your review helps create one
                </span>
              </div>
            )}

            {/* Overall Rating */}
            <div>
              <label className="block text-sm text-cinema-muted mb-2">
                Overall Rating: <span className="text-cinema-gold font-bold text-lg">{overallRating}</span>
              </label>
              <input
                type="range"
                min={1}
                max={10}
                step={0.5}
                value={overallRating}
                onChange={(e) => setOverallRating(parseFloat(e.target.value))}
                className="w-full accent-cinema-gold"
              />
              <div className="flex justify-between text-xs text-cinema-muted/60 mt-1">
                <span>1</span>
                <span>5.5</span>
                <span>10</span>
              </div>
            </div>

            {/* Beat Sliders (only for films with graphs) */}
            {hasGraph && selectedBeats.length > 0 && (
              <div>
                <p className="text-sm text-cinema-muted mb-4">Rate each story beat:</p>
                <div className="space-y-3">
                  {selectedBeats.map(({ beat, tag }) => {
                    const borderColor =
                      tag === 'peak'
                        ? 'rgba(45,212,168,0.3)'
                        : tag === 'lowest'
                          ? 'rgba(239,68,68,0.3)'
                          : 'rgba(255,255,255,0.06)'
                    return (
                      <div
                        key={beat.label}
                        className="rounded-lg"
                        style={{
                          padding: '16px 18px',
                          border: `1px solid ${borderColor}`,
                          backgroundColor: 'rgba(255,255,255,0.02)',
                        }}
                      >
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex-1 mr-3">
                            <span className="text-sm text-cinema-cream leading-snug block">
                              {beat.label}
                            </span>
                            {tag === 'peak' && (
                              <span className="text-[10px] text-[#2DD4A8] mt-0.5 inline-block">
                                ⬆ Peak moment
                              </span>
                            )}
                            {tag === 'lowest' && (
                              <span className="text-[10px] text-red-400 mt-0.5 inline-block">
                                ⬇ Lowest moment
                              </span>
                            )}
                          </div>
                          <span className="text-cinema-gold font-bold text-lg shrink-0">
                            {beatRatings[beat.label]?.toFixed(1) ?? '5.0'}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={1}
                          max={10}
                          step={0.5}
                          value={beatRatings[beat.label] ?? 5}
                          onChange={(e) =>
                            setBeatRatings((prev) => ({
                              ...prev,
                              [beat.label]: parseFloat(e.target.value),
                            }))
                          }
                          className="w-full accent-cinema-gold"
                        />
                        <div className="flex justify-between text-[10px] text-cinema-muted/50 mt-1">
                          <span>Hated it</span>
                          <span>Neutral</span>
                          <span>Loved it</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Text Sections */}
            <div className="space-y-3">
              <TextArea
                label="How did it start?"
                placeholder="Your thoughts on the beginning..."
                value={beginning}
                onChange={setBeginning}
              />
              <TextArea
                label="How was the middle?"
                placeholder="Your thoughts on the middle..."
                value={middle}
                onChange={setMiddle}
              />
              <TextArea
                label="How did it end?"
                placeholder="Your thoughts on the ending..."
                value={ending}
                onChange={setEnding}
              />
              <TextArea
                label="Anything else?"
                placeholder="Other thoughts..."
                value={otherThoughts}
                onChange={setOtherThoughts}
              />
            </div>

            {error && (
              <p className="text-red-400 text-sm">{error}</p>
            )}

            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full py-3 rounded-lg font-medium transition-all duration-200 disabled:opacity-50"
              style={{
                backgroundColor: session ? '#C8A951' : 'transparent',
                color: session ? '#1a1a2e' : '#C8A951',
                border: session ? 'none' : '1px solid #C8A951',
              }}
            >
              {submitting
                ? 'Submitting...'
                : session
                  ? editing
                    ? 'Update Review'
                    : 'Submit Review'
                  : 'Sign in to Review'}
            </button>
          </div>
        )}
      </div>

      {/* Community Summary */}
      {summary && summary.totalReviews > 0 && (
        <div className="bg-cinema-darker rounded-lg border border-cinema-border p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-[family-name:var(--font-playfair)] text-lg text-cinema-cream">
              Community Reviews
            </h3>
            <div className="flex items-baseline gap-2">
              <span className="font-[family-name:var(--font-bebas)] text-3xl text-cinema-gold">
                {summary.avgRating?.toFixed(1)}
              </span>
              <span className="text-xs text-cinema-muted">
                from {summary.totalReviews} review{summary.totalReviews !== 1 ? 's' : ''}
              </span>
            </div>
          </div>

          {/* Score Distribution */}
          <div className="space-y-1">
            {summary.distribution.map((d) => (
              <div key={d.score} className="flex items-center gap-2 text-xs">
                <span className="w-4 text-cinema-muted text-right">{d.score}</span>
                <div className="flex-1 h-3 bg-cinema-card rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${(d.count / maxCount) * 100}%`,
                      backgroundColor: d.score >= 8 ? '#2DD4A8' : d.score >= 6 ? '#C8A951' : '#ef4444',
                    }}
                  />
                </div>
                <span className="w-4 text-cinema-muted">{d.count}</span>
              </div>
            ))}
          </div>

          {/* Section Sentiment */}
          {(summary.sectionCounts.beginning > 0 ||
            summary.sectionCounts.middle > 0 ||
            summary.sectionCounts.ending > 0) && (
            <div className="flex gap-4 text-xs text-cinema-muted">
              <span>{summary.sectionCounts.beginning} wrote about beginning</span>
              <span>{summary.sectionCounts.middle} wrote about middle</span>
              <span>{summary.sectionCounts.ending} wrote about ending</span>
            </div>
          )}

          {/* Reviews List */}
          {!showAll && summary.totalReviews > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="text-sm text-cinema-gold hover:text-cinema-gold/80 transition-colors"
            >
              Show all {summary.totalReviews} reviews ↓
            </button>
          )}

          {showAll && (
            <div className="space-y-3">
              {reviews.map((review) => (
                <ReviewCard key={review.id} review={review} currentUserId={session?.user?.id} onDelete={async (id) => {
                  const res = await fetch(`/api/reviews/${id}`, { method: 'DELETE' })
                  if (res.ok) {
                    setReviews((prev) => prev.filter((r) => r.id !== id))
                    fetchReviews(1)
                  }
                }} />
              ))}
              {page < totalPages && (
                <button
                  onClick={() => {
                    const next = page + 1
                    setPage(next)
                    fetchReviews(next)
                  }}
                  className="text-sm text-cinema-gold hover:text-cinema-gold/80 transition-colors"
                >
                  Load more
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="text-center py-4 text-cinema-muted text-sm">Loading reviews...</div>
      )}
    </div>
  )
}

function TextArea({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="block text-sm text-cinema-muted mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full bg-cinema-card border border-cinema-border rounded-lg px-3 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/40 resize-none"
      />
    </div>
  )
}

function ReviewCard({
  review,
  currentUserId,
  onDelete,
}: {
  review: ReviewData
  currentUserId?: string
  onDelete: (id: string) => void
}) {
  return (
    <div className="bg-cinema-card border border-cinema-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {review.user.name ? (
            <Link href={`/profile/${review.user.id}`} className="flex items-center gap-2 group cursor-pointer">
              {review.user.image ? (
                <Image
                  src={review.user.image}
                  alt={review.user.name}
                  width={28}
                  height={28}
                  className="rounded-full"
                />
              ) : (
                <div className="w-7 h-7 rounded-full bg-cinema-gold/20 flex items-center justify-center text-cinema-gold text-xs">
                  {review.user.name[0]}
                </div>
              )}
              <span className="text-sm text-cinema-cream group-hover:underline group-hover:decoration-cinema-gold/50 group-hover:underline-offset-2">
                {review.user.name}
              </span>
            </Link>
          ) : (
            <>
              <div className="w-7 h-7 rounded-full bg-cinema-gold/20 flex items-center justify-center text-cinema-gold text-xs">
                ?
              </div>
              <span className="text-sm text-cinema-cream">Anonymous</span>
            </>
          )}
          <span className="text-xs text-cinema-muted">
            {new Date(review.createdAt).toLocaleDateString()}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-sm font-bold px-2 py-0.5 rounded"
            style={{
              backgroundColor:
                review.overallRating >= 8
                  ? '#2DD4A8'
                  : review.overallRating >= 6
                    ? '#C8A951'
                    : '#ef4444',
              color: '#1a1a2e',
            }}
          >
            {review.overallRating.toFixed(1)}
          </span>
          {currentUserId === review.user.id && (
            <button
              onClick={() => onDelete(review.id)}
              className="text-xs text-red-400 hover:text-red-300"
            >
              Delete
            </button>
          )}
        </div>
      </div>
      {review.combinedText && (
        <p className="text-sm text-cinema-cream/80 leading-relaxed">{review.combinedText}</p>
      )}
    </div>
  )
}
