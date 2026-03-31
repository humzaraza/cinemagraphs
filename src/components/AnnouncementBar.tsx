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

export default function AnnouncementBar() {
  const [announcement, setAnnouncement] = useState<AnnouncementData | null>(null)

  useEffect(() => {
    fetch('/api/announcements/current')
      .then((res) => res.json())
      .then((data) => {
        if (data.announcement) setAnnouncement(data.announcement)
      })
      .catch(() => {})
  }, [])

  if (!announcement) return null

  const authorName = announcement.author.name || 'Humza'
  const initial = authorName.charAt(0).toUpperCase()

  return (
    <section className="max-w-7xl mx-auto px-4 pt-8 pb-0">
      <div
        className="rounded-lg px-5 py-4"
        style={{
          backgroundColor: 'rgba(200,169,110,0.06)',
          border: '0.5px solid rgba(200,169,110,0.15)',
        }}
      >
        {/* Header row: avatar + name + badge | timestamp */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            {/* Avatar */}
            {announcement.author.image ? (
              <img
                src={announcement.author.image}
                alt={authorName}
                className="w-8 h-8 rounded-full object-cover"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
                style={{ backgroundColor: 'rgba(200,169,110,0.2)', color: '#c8a96e' }}
              >
                {initial}
              </div>
            )}
            {/* Name + badge */}
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-cinema-cream">{authorName}</span>
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ backgroundColor: 'rgba(200,169,110,0.15)', color: '#c8a96e' }}
              >
                Founder
              </span>
            </div>
          </div>
          {/* Timestamp */}
          <span className="text-xs text-cinema-muted shrink-0">{timeAgo(announcement.createdAt)}</span>
        </div>
        {/* Message */}
        <p
          className="leading-relaxed"
          style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)' }}
        >
          {announcement.message}
        </p>
      </div>
    </section>
  )
}
