'use client'

import { useState } from 'react'

interface Props {
  onClose: () => void
  onCreated: (list: { id: string; name: string }) => void
}

const GENRE_OPTIONS = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Music',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Thriller',
  'War',
  'Western',
]

export default function NewListModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [genreTag, setGenreTag] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setStatus('saving')
    setErrorMsg('')

    try {
      const res = await fetch('/api/user/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), genreTag: genreTag || null }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to create list')
      }

      const created = await res.json()
      onCreated({ id: created.id, name: created.name })
    } catch (err) {
      setErrorMsg((err as Error).message)
      setStatus('error')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-md bg-cinema-darker border border-cinema-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-cinema-border">
          <h2 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream">
            New list
          </h2>
          <button
            onClick={onClose}
            className="text-cinema-muted hover:text-cinema-cream transition-colors"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm text-cinema-muted mb-1">List name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
              required
              className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2.5 text-sm text-cinema-cream placeholder:text-cinema-muted/50 focus:outline-none focus:border-cinema-gold/50"
              placeholder="e.g. Best of 2024"
            />
          </div>

          <div>
            <label className="block text-sm text-cinema-muted mb-1">Genre tag (optional)</label>
            <select
              value={genreTag}
              onChange={(e) => setGenreTag(e.target.value)}
              className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2.5 text-sm text-cinema-cream focus:outline-none focus:border-cinema-gold/50"
            >
              <option value="">None</option>
              {GENRE_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>

          {errorMsg && (
            <p className="text-sm text-red-400">{errorMsg}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-cinema-muted hover:text-cinema-cream transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={status === 'saving' || !name.trim()}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-cinema-gold text-cinema-dark hover:bg-cinema-gold/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {status === 'saving' ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
