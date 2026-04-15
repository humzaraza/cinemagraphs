'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import {
  type ListStatus,
  toggleListStatus,
  prependCreatedList,
  shouldCloseOnOutsideEvent,
} from '@/lib/addToListHelpers'

interface Props {
  filmId: string
}

// Module-level cache keyed by filmId so reopening the dropdown for the
// same film doesn't refetch. Invalidated locally when we mutate.
const listCache = new Map<string, ListStatus[]>()

export default function AddToListDropdown({ filmId }: Props) {
  const { data: session } = useSession()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [lists, setLists] = useState<ListStatus[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    setCreating(false)
    setNewName('')
  }, [])

  // Fetch when opening, use cache when available
  useEffect(() => {
    if (!open || !session?.user?.id) return
    const cached = listCache.get(filmId)
    if (cached) {
      setLists(cached)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/user/lists/check/${filmId}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        const result: ListStatus[] = data.lists ?? []
        listCache.set(filmId, result)
        setLists(result)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, filmId, session?.user?.id])

  // Close on outside click + escape
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (shouldCloseOnOutsideEvent(containerRef.current, e.target as Node | null)) {
        close()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  if (!session?.user?.id) return null

  const updateCache = (next: ListStatus[]) => {
    listCache.set(filmId, next)
    setLists(next)
  }

  const toggleList = async (listId: string) => {
    const current = lists ?? []
    const { next, wasIn } = toggleListStatus(current, listId)
    // Optimistic update
    updateCache(next)
    try {
      const res = await fetch(`/api/user/lists/${listId}/films`, {
        method: wasIn ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filmId }),
      })
      if (!res.ok) throw new Error('toggle failed')
    } catch {
      // Revert on failure
      updateCache(current)
    }
  }

  const createAndAdd = async () => {
    const name = newName.trim()
    if (!name) {
      setCreating(false)
      return
    }
    try {
      const createRes = await fetch('/api/user/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!createRes.ok) throw new Error('create failed')
      const created = await createRes.json()

      await fetch(`/api/user/lists/${created.id}/films`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filmId }),
      })

      const next = prependCreatedList(lists ?? [], {
        id: created.id,
        name: created.name,
      })
      updateCache(next)
    } catch {
      // noop — creation or add failed; leave UI unchanged
    } finally {
      setCreating(false)
      setNewName('')
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Add to list"
        className={`inline-flex items-center justify-center gap-2 border px-3.5 py-2.5 rounded-lg transition-colors ${
          open
            ? 'border-cinema-gold text-cinema-gold bg-cinema-gold/10'
            : 'border-cinema-gold/30 text-cinema-gold hover:bg-cinema-gold/10 hover:border-cinema-gold'
        }`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span className="text-sm">Add to List</span>
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-2 w-[300px] rounded-xl bg-[#13132A] z-40"
          style={{
            border: '1px solid rgba(200,169,81,0.2)',
            boxShadow: '0 20px 40px -10px rgba(0,0,0,0.6), 0 8px 16px -6px rgba(0,0,0,0.4)',
          }}
          role="menu"
        >
          {/* Notch pointing up to the button */}
          <div
            className="absolute -top-[6px] left-6 w-3 h-3 rotate-45 bg-[#13132A]"
            style={{
              borderTop: '1px solid rgba(200,169,81,0.2)',
              borderLeft: '1px solid rgba(200,169,81,0.2)',
            }}
          />

          <div className="px-4 pt-4 pb-2">
            <div className="text-[12px] uppercase text-cinema-muted font-semibold" style={{ letterSpacing: '0.5px' }}>
              Your lists
            </div>
          </div>

          {loading && (
            <div className="px-4 py-4 text-[13px] text-cinema-muted">Loading…</div>
          )}

          {!loading && lists && lists.length === 0 && (
            <div className="px-4 pb-3 text-[13px] text-cinema-muted">No lists yet.</div>
          )}

          {!loading && lists && lists.length > 0 && (
            <div className="max-h-[240px] overflow-y-auto">
              {lists.map((l) => (
                <button
                  key={l.listId}
                  type="button"
                  onClick={() => toggleList(l.listId)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
                  style={{
                    backgroundColor: 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'rgba(200,169,81,0.08)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent'
                  }}
                  aria-pressed={l.containsFilm}
                >
                  {l.containsFilm ? (
                    <span className="relative flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0" style={{ backgroundColor: '#2DD4A8' }}>
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#0B0B20"
                        strokeWidth="3.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                  ) : (
                    <span
                      className="w-[18px] h-[18px] rounded-full flex-shrink-0"
                      style={{ border: '1.5px solid rgba(245,240,225,0.15)' }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-cinema-cream truncate">
                      {l.listName}
                    </div>
                    <div className="text-[10px] text-cinema-muted">
                      {l.filmCount} {l.filmCount === 1 ? 'film' : 'films'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Divider */}
          <div
            className="h-px mx-3 my-1"
            style={{ backgroundColor: 'rgba(245,240,225,0.08)' }}
          />

          {creating ? (
            <div className="px-4 py-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    createAndAdd()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setCreating(false)
                    setNewName('')
                  }
                }}
                onBlur={() => {
                  if (!newName.trim()) {
                    setCreating(false)
                  }
                }}
                placeholder="List name"
                autoFocus
                maxLength={80}
                className="w-full bg-transparent rounded-md px-2.5 py-1.5 text-[13px] text-cinema-cream placeholder:text-cinema-muted/50 outline-none"
                style={{
                  border: '1px solid rgba(200,169,81,0.3)',
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left text-cinema-gold transition-colors rounded-b-xl"
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(200,169,81,0.08)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent'
              }}
            >
              <span className="w-[18px] h-[18px] flex items-center justify-center flex-shrink-0">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </span>
              <span className="text-[13px] font-medium">Create new list</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
