'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { tmdbImageUrl } from '@/lib/utils'

interface FilmSearchResult {
  id: string
  title: string
  posterUrl: string | null
  releaseDate: string | null
}

interface Props {
  listId: string
  existingFilmIds: Set<string>
  onClose: () => void
  onAdded: (filmId: string) => void
}

export default function AddFilmsModal({ listId, existingFilmIds, onClose, onAdded }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FilmSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [addedIds, setAddedIds] = useState<Set<string>>(() => new Set(existingFilmIds))
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/films?q=${encodeURIComponent(query.trim())}&limit=20`, {
          signal: ctrl.signal,
        })
        if (!res.ok) throw new Error('Search failed')
        const data = await res.json()
        const films: FilmSearchResult[] = (data.films || []).map((f: FilmSearchResult) => ({
          id: f.id,
          title: f.title,
          posterUrl: f.posterUrl,
          releaseDate: f.releaseDate,
        }))
        setResults(films)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setResults([])
        }
      } finally {
        setLoading(false)
      }
    }, 250)

    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [query])

  const handleAdd = async (film: FilmSearchResult) => {
    if (addedIds.has(film.id)) return
    setPendingId(film.id)
    setErrorMsg('')

    try {
      const res = await fetch(`/api/user/lists/${listId}/films`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filmId: film.id }),
      })
      if (!res.ok && res.status !== 409) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to add film')
      }
      setAddedIds((prev) => new Set(prev).add(film.id))
      onAdded(film.id)
    } catch (err) {
      setErrorMsg((err as Error).message)
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-16"
      onClick={onClose}
    >
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-xl bg-cinema-darker border border-cinema-border rounded-xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-cinema-border">
          <h2 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream">
            Add films to list
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

        <div className="p-5 pb-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            placeholder="Search films by title…"
            className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2.5 text-sm text-cinema-cream placeholder:text-cinema-muted/50 focus:outline-none focus:border-cinema-gold/50"
          />
          {errorMsg && <p className="text-xs text-red-400 mt-2">{errorMsg}</p>}
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {loading && <p className="text-xs text-cinema-muted py-2">Searching…</p>}
          {!loading && query.trim() && results.length === 0 && (
            <p className="text-xs text-cinema-muted py-2">No films found.</p>
          )}
          {!query.trim() && !loading && (
            <p className="text-xs text-cinema-muted py-2">
              Start typing to search films in Cinemagraphs.
            </p>
          )}
          <ul className="space-y-1.5">
            {results.map((film) => {
              const added = addedIds.has(film.id)
              const pending = pendingId === film.id
              const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : null
              return (
                <li key={film.id}>
                  <button
                    onClick={() => handleAdd(film)}
                    disabled={added || pending}
                    className="w-full flex items-center gap-3 p-2 rounded-lg text-left transition-colors border border-transparent hover:border-cinema-gold/20 hover:bg-cinema-gold/5 disabled:opacity-60"
                  >
                    <div className="w-10 h-[60px] relative rounded overflow-hidden bg-cinema-dark flex-shrink-0">
                      {film.posterUrl ? (
                        <Image
                          src={tmdbImageUrl(film.posterUrl, 'w92')}
                          alt={film.title}
                          fill
                          unoptimized
                          className="object-cover"
                          sizes="40px"
                        />
                      ) : null}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-cinema-cream truncate">{film.title}</p>
                      {year && <p className="text-xs text-cinema-muted">{year}</p>}
                    </div>
                    {added ? (
                      <span className="text-cinema-teal flex-shrink-0" aria-label="Already added">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </span>
                    ) : pending ? (
                      <span className="text-xs text-cinema-muted flex-shrink-0">Adding…</span>
                    ) : (
                      <span className="text-cinema-gold flex-shrink-0">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
