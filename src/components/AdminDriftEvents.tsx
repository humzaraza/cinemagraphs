'use client'

import { useState, useEffect } from 'react'

type MismatchReason = 'not_in_existing' | 'missing_from_incoming'

interface MismatchedLabel {
  incoming: string
  reason: MismatchReason
}

interface DriftEvent {
  id: string
  occurredAt: string
  filmId: string
  filmTitle: string | null
  callerPath: string
  existingBeatCount: number
  incomingBeatCount: number
  action: string
  mismatchedLabels: MismatchedLabel[] | unknown
  envLockEnabled: boolean
}

function summarizeMismatches(raw: unknown): { dropped: number; preserved: number } {
  const labels = Array.isArray(raw) ? (raw as MismatchedLabel[]) : []
  let dropped = 0
  let preserved = 0
  for (const entry of labels) {
    if (entry?.reason === 'not_in_existing') dropped++
    else if (entry?.reason === 'missing_from_incoming') preserved++
  }
  return { dropped, preserved }
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function AdminDriftEvents() {
  const [events, setEvents] = useState<DriftEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function fetchEvents() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/admin/drift-log')
        if (!res.ok) {
          throw new Error(`Request failed with status ${res.status}`)
        }
        const data = await res.json()
        if (!cancelled) setEvents(data.events ?? [])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load drift events')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchEvents()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return <p className="text-sm text-cinema-muted">Loading drift events…</p>
  }

  if (error) {
    return <p className="text-sm text-red-400">{error}</p>
  }

  if (events.length === 0) {
    return (
      <p className="text-sm text-cinema-muted">
        No drift events recorded in the last 30 days.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-cinema-muted">
        Showing the latest {events.length} drift events from the last 30 days.
      </p>
      <div className="space-y-3">
        {events.map((event) => {
          const { dropped, preserved } = summarizeMismatches(event.mismatchedLabels)
          return (
            <div
              key={event.id}
              className="bg-cinema-card border border-cinema-border rounded-lg p-4 space-y-2"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium text-cinema-teal">
                    {event.filmTitle ?? 'Unknown film'}
                  </p>
                  <p className="text-xs text-cinema-muted font-mono">{event.filmId}</p>
                </div>
                <p className="text-xs text-cinema-muted whitespace-nowrap">
                  {formatTimestamp(event.occurredAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span className="text-cinema-muted">
                  Caller: <span className="text-cinema-teal font-mono">{event.callerPath}</span>
                </span>
                <span className="text-cinema-muted">
                  Beats: <span className="text-cinema-teal">{event.existingBeatCount}</span>
                  {' → '}
                  <span className="text-cinema-teal">{event.incomingBeatCount}</span>
                </span>
                <span className="text-cinema-muted">
                  Action: <span className="text-cinema-teal font-mono">{event.action}</span>
                </span>
              </div>
              {(dropped > 0 || preserved > 0) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {dropped > 0 && (
                    <span className="text-red-400">{dropped} labels dropped</span>
                  )}
                  {preserved > 0 && (
                    <span className="text-amber-400">{preserved} labels preserved</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
