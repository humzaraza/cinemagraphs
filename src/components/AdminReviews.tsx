'use client'

import { useState, useEffect, useCallback } from 'react'
import { formatReviewProse } from '@/lib/review-prose'

interface AdminReview {
  id: string
  overallRating: number
  beginning: string | null
  middle: string | null
  ending: string | null
  otherThoughts: string | null
  combinedText: string | null
  beatRatings: Record<string, number> | null
  status: string
  flagReason: string | null
  createdAt: string
  user: { id: string; name: string | null; email: string | null; image: string | null }
  film: { id: string; title: string; posterUrl: string | null }
}

export default function AdminReviews() {
  const [reviews, setReviews] = useState<AdminReview[]>([])
  const [flaggedCount, setFlaggedCount] = useState(0)
  const [tab, setTab] = useState<'flagged' | 'all'>('flagged')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const fetchReviews = useCallback(async () => {
    setLoading(true)
    const status = tab === 'flagged' ? 'flagged' : 'all'
    const params = new URLSearchParams({ status })
    if (search.trim()) params.set('search', search.trim())
    try {
      const res = await fetch(`/api/admin/reviews?${params}`)
      if (res.ok) {
        const data = await res.json()
        setReviews(data.reviews)
        setFlaggedCount(data.flaggedCount)
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [tab, search])

  useEffect(() => {
    fetchReviews()
  }, [fetchReviews])

  async function handleAction(reviewId: string, status: 'approved' | 'rejected') {
    const res = await fetch(`/api/admin/reviews/${reviewId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (res.ok) {
      setReviews((prev) => prev.filter((r) => r.id !== reviewId))
      setFlaggedCount((c) => Math.max(0, c - 1))
    }
  }

  async function handleDelete(reviewId: string) {
    const res = await fetch(`/api/admin/reviews/${reviewId}`, { method: 'DELETE' })
    if (res.ok) {
      setReviews((prev) => prev.filter((r) => r.id !== reviewId))
      setDeleteConfirm(null)
      // Refresh flagged count
      fetchReviews()
    }
  }

  return (
    <div className="space-y-6">
      {/* Sub-tabs */}
      <div className="flex gap-2 items-center">
        <button
          onClick={() => setTab('flagged')}
          className="px-4 py-1.5 rounded text-sm font-medium transition-colors"
          style={{
            backgroundColor: tab === 'flagged' ? '#C8A951' : 'transparent',
            color: tab === 'flagged' ? '#1a1a2e' : '#888',
            border: tab === 'flagged' ? 'none' : '1px solid rgba(255,255,255,0.1)',
          }}
        >
          Flagged
          {flaggedCount > 0 && (
            <span className="ml-1.5 bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">
              {flaggedCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('all')}
          className="px-4 py-1.5 rounded text-sm font-medium transition-colors"
          style={{
            backgroundColor: tab === 'all' ? '#C8A951' : 'transparent',
            color: tab === 'all' ? '#1a1a2e' : '#888',
            border: tab === 'all' ? 'none' : '1px solid rgba(255,255,255,0.1)',
          }}
        >
          All Reviews
        </button>
      </div>

      {/* Search (All Reviews tab only) */}
      {tab === 'all' && (
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by film name or username..."
          className="w-full bg-cinema-card border border-cinema-border rounded-lg px-4 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/40"
        />
      )}

      {loading ? (
        <p className="text-cinema-muted text-sm">Loading reviews...</p>
      ) : reviews.length === 0 ? (
        <div className="text-center py-10">
          <p className="text-cinema-muted text-sm">
            {tab === 'flagged'
              ? 'No flagged reviews — all clear'
              : 'No reviews found'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {reviews.map((review) => (
            <div
              key={review.id}
              className="bg-cinema-card border border-cinema-border rounded-lg p-5 space-y-3"
            >
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-cinema-gold/20 flex items-center justify-center text-cinema-gold text-xs font-bold">
                    {(review.user.name || review.user.email || '?')[0].toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm text-cinema-cream font-medium">
                      {review.user.name || review.user.email}
                    </p>
                    <p className="text-xs text-cinema-muted">
                      {new Date(review.createdAt).toLocaleDateString()} — {review.film.title}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="text-xs px-2 py-0.5 rounded"
                    style={{
                      backgroundColor:
                        review.status === 'approved'
                          ? 'rgba(45,212,168,0.15)'
                          : review.status === 'flagged'
                            ? 'rgba(200,169,81,0.15)'
                            : 'rgba(239,68,68,0.15)',
                      color:
                        review.status === 'approved'
                          ? '#2DD4A8'
                          : review.status === 'flagged'
                            ? '#C8A951'
                            : '#ef4444',
                    }}
                  >
                    {review.status}
                  </span>
                  <span
                    className="text-lg font-bold px-3 py-1 rounded"
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
                </div>
              </div>

              {/* Flag Reason */}
              {review.flagReason && (
                <div className="bg-cinema-gold/10 border border-cinema-gold/20 rounded px-3 py-2">
                  <p className="text-xs text-cinema-gold">
                    <span className="font-medium">Flag reason:</span> {review.flagReason}
                  </p>
                </div>
              )}

              {/* Beat Ratings */}
              {review.beatRatings && Object.keys(review.beatRatings).length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-cinema-muted uppercase tracking-wider">Beat Ratings</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {Object.entries(review.beatRatings).map(([label, score]) => (
                      <div key={label} className="bg-cinema-darker rounded px-2 py-1.5 text-xs">
                        <span className="text-cinema-muted block">{label}</span>
                        <span
                          className="font-bold"
                          style={{
                            color: score >= 8 ? '#2DD4A8' : score >= 6 ? '#C8A951' : '#ef4444',
                          }}
                        >
                          {score.toFixed(1)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Prose */}
              {(() => {
                const prose = formatReviewProse(review)
                return prose ? (
                  <p className="text-sm text-cinema-cream/80 whitespace-pre-line">{prose}</p>
                ) : null
              })()}

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                {review.status === 'flagged' && (
                  <>
                    <button
                      onClick={() => handleAction(review.id, 'approved')}
                      className="px-4 py-1.5 rounded text-sm font-medium bg-[#2DD4A8] text-[#1a1a2e] hover:bg-[#2DD4A8]/80 transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleAction(review.id, 'rejected')}
                      className="px-4 py-1.5 rounded text-sm font-medium bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => handleAction(review.id, 'approved')}
                      className="px-4 py-1.5 rounded text-sm font-medium text-cinema-muted border border-cinema-border hover:border-cinema-gold/40 transition-colors"
                    >
                      Dismiss Flag
                    </button>
                  </>
                )}
                {deleteConfirm === review.id ? (
                  <div className="flex items-center gap-2 ml-auto">
                    <span className="text-xs text-red-400">Delete permanently?</span>
                    <button
                      onClick={() => handleDelete(review.id)}
                      className="px-3 py-1 rounded text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
                    >
                      Yes, delete
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(null)}
                      className="px-3 py-1 rounded text-xs text-cinema-muted border border-cinema-border hover:border-cinema-gold/40 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteConfirm(review.id)}
                    className="px-3 py-1.5 rounded text-sm text-red-400/60 hover:text-red-400 transition-colors ml-auto"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
