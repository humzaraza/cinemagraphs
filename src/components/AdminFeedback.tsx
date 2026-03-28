'use client'

import { useState, useEffect } from 'react'

interface FeedbackItem {
  id: string
  type: string
  message: string
  page: string
  createdAt: string
  user: { name: string | null; email: string } | null
}

const TYPE_COLORS: Record<string, string> = {
  bug: 'bg-red-500/20 text-red-400 border-red-500/30',
  suggestion: 'bg-cinema-gold/20 text-cinema-gold border-cinema-gold/30',
  support: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  other: 'bg-cinema-muted/20 text-cinema-muted border-cinema-muted/30',
}

export default function AdminFeedback() {
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/admin/feedback')
      .then((r) => r.json())
      .then((data) => setItems(data.feedback ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <p className="text-cinema-muted py-8 text-center">Loading feedback...</p>
  }

  if (items.length === 0) {
    return <p className="text-cinema-muted py-8 text-center">No feedback yet.</p>
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div
          key={item.id}
          className="bg-cinema-card border border-cinema-border rounded-lg p-4"
        >
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded-full border ${TYPE_COLORS[item.type] || TYPE_COLORS.other}`}>
                {item.type}
              </span>
              <span className="text-sm text-cinema-muted">
                {item.user?.name || item.user?.email || 'Anonymous'}
              </span>
            </div>
            <span className="text-xs text-cinema-muted whitespace-nowrap">
              {new Date(item.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
          </div>
          <p className="text-sm text-cinema-cream whitespace-pre-wrap mb-2">{item.message}</p>
          <p className="text-xs text-cinema-muted">
            Page: <span className="text-cinema-cream/70">{item.page}</span>
          </p>
        </div>
      ))}
    </div>
  )
}
