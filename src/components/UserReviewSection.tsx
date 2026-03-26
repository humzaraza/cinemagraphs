'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession, signIn } from 'next-auth/react'
import Image from 'next/image'

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

export default function UserReviewSection({ filmId, hasGraph, beats }: Props) {
  const { data: session } = useSession()
  const [overallRating, setOverallRating] = useState(5)
  const [beatRatings, setBeatRatings] = useState<Record<string, number>>({})
  const [beginning, setBeginning] = useState('')
  const [middle, setMiddle] = useState('')
  const [ending, setEnding] = useState('')
  const [otherThoughts, setOtherThoughts] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Community data
  const [reviews, setReviews] = useState<ReviewData[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(true)

  // Initialize beat ratings
  useEffect(() => {
    if (hasGraph && beats.length > 0) {
      const initial: Record<string, number> = {}
      for (const beat of beats) {
        initial[beat.label] = 5
      }
      setBeatRatings(initial)
    }
  }, [hasGraph, beats])

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

        {submitted ? (
          <div className="text-center py-8">
            <div className="text-3xl mb-2">✓</div>
            <p className="text-cinema-cream text-lg font-medium">Review submitted!</p>
            <p className="text-cinema-muted text-sm mt-1">
              Thank you for contributing to this film&apos;s sentiment graph.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            <h3 className="font-[family-name:var(--font-playfair)] text-lg text-cinema-cream">
              Write a Review
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
                <span>5</span>
                <span>10</span>
              </div>
            </div>

            {/* Beat Sliders (only for films with graphs) */}
            {hasGraph && beats.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm text-cinema-muted">Rate each story beat:</p>
                {beats.map((beat) => (
                  <div key={beat.label}>
                    <div className="flex justify-between text-xs text-cinema-muted mb-1">
                      <span className="truncate max-w-[200px]">{beat.label}</span>
                      <span className="text-cinema-gold font-bold">
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
                  </div>
                ))}
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
                  ? 'Submit Review'
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
          {review.user.image ? (
            <Image
              src={review.user.image}
              alt={review.user.name || 'User'}
              width={28}
              height={28}
              className="rounded-full"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-cinema-gold/20 flex items-center justify-center text-cinema-gold text-xs">
              {(review.user.name || '?')[0]}
            </div>
          )}
          <span className="text-sm text-cinema-cream">{review.user.name || 'Anonymous'}</span>
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
