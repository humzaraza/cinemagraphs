'use client'

import { useEffect, useState } from 'react'

interface AnnouncementData {
  id: string
  message: string
  createdAt: string
  author: {
    name: string | null
    image: string | null
  }
}

export default function AdminAnnouncements() {
  const [current, setCurrent] = useState<AnnouncementData | null>(null)
  const [message, setMessage] = useState('')
  const [posting, setPosting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const fetchCurrent = () => {
    fetch('/api/announcements/current')
      .then((res) => res.json())
      .then((data) => setCurrent(data.announcement || null))
      .catch(() => {})
  }

  useEffect(() => {
    fetchCurrent()
  }, [])

  const handlePost = async () => {
    if (!message.trim()) return
    setPosting(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to post announcement')
        return
      }
      const data = await res.json()
      setCurrent(data.announcement)
      setMessage('')
      setSuccess('Announcement posted successfully')
      setTimeout(() => setSuccess(null), 3000)
    } catch {
      setError('Failed to post announcement')
    } finally {
      setPosting(false)
    }
  }

  const handleDelete = async () => {
    if (!current) return
    setDeleting(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch(`/api/announcements/${current.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        setError('Failed to delete announcement')
        return
      }
      setCurrent(null)
      setSuccess('Announcement deleted')
      setTimeout(() => setSuccess(null), 3000)
    } catch {
      setError('Failed to delete announcement')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Current pinned announcement */}
      {current && (
        <div className="rounded-lg border border-cinema-border bg-cinema-card p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-cinema-cream">Current Pinned Announcement</h3>
            <span
              className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'rgba(200,169,110,0.15)', color: '#c8a96e' }}
            >
              Live
            </span>
          </div>
          <p className="text-sm text-cinema-muted leading-relaxed mb-4">
            {current.message}
          </p>
          <div className="flex items-center justify-between">
            <span className="text-xs text-cinema-muted">
              Posted by {current.author.name || 'Unknown'} on{' '}
              {new Date(current.createdAt).toLocaleDateString('en-CA', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
      )}

      {!current && (
        <div className="rounded-lg border border-cinema-border bg-cinema-card p-5 text-center">
          <p className="text-sm text-cinema-muted">No announcement is currently pinned.</p>
        </div>
      )}

      {/* Post new announcement */}
      <div className="rounded-lg border border-cinema-border bg-cinema-card p-5">
        <h3 className="text-sm font-semibold text-cinema-cream mb-3">
          {current ? 'Replace Announcement' : 'Post New Announcement'}
        </h3>
        <div className="relative">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, 500))}
            placeholder="Write an announcement for the homepage..."
            rows={4}
            className="w-full rounded-lg bg-cinema-dark border border-cinema-border px-4 py-3 text-sm text-cinema-cream placeholder-cinema-muted/50 resize-none focus:outline-none focus:border-cinema-gold/40"
          />
          <span
            className="absolute bottom-3 right-3 text-xs"
            style={{ color: message.length > 450 ? '#ef4444' : 'rgba(255,255,255,0.3)' }}
          >
            {message.length}/500
          </span>
        </div>
        <div className="flex items-center justify-between mt-3">
          <p className="text-xs text-cinema-muted">
            {current ? 'Posting will replace the current announcement.' : 'This will appear on the homepage.'}
          </p>
          <button
            onClick={handlePost}
            disabled={posting || !message.trim()}
            className="px-5 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40"
            style={{ backgroundColor: '#c8a96e', color: '#0f1117' }}
          >
            {posting ? 'Posting...' : 'Post'}
          </button>
        </div>
      </div>

      {/* Status messages */}
      {error && (
        <div className="p-3 rounded-lg text-sm text-red-400" style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 rounded-lg text-sm text-green-400" style={{ backgroundColor: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.2)' }}>
          {success}
        </div>
      )}
    </div>
  )
}
