'use client'

import { useState } from 'react'
import Image from 'next/image'
import { tmdbImageUrl } from '@/lib/utils'

interface TMDBResult {
  id: number
  title: string
  release_date?: string
  poster_path?: string
  overview?: string
}

export default function AdminFilmImport() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TMDBResult[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState<number | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim()) return

    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/films/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')
      setResults(data.results || [])
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Search failed' })
    } finally {
      setLoading(false)
    }
  }

  async function handleImport(tmdbId: number) {
    setImporting(tmdbId)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/films/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmdbId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Import failed')
      setMessage({ type: 'success', text: `Imported "${data.film.title}" successfully` })
      setResults((prev) => prev.filter((r) => r.id !== tmdbId))
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Import failed' })
    } finally {
      setImporting(null)
    }
  }

  return (
    <div>
      <form onSubmit={handleSearch} className="flex gap-3 mb-6">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search TMDB for a movie..."
          className="flex-1 bg-cinema-dark border border-cinema-border rounded-lg px-4 py-2 text-cinema-cream placeholder:text-cinema-muted focus:outline-none focus:border-cinema-gold/50"
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-cinema-gold text-cinema-dark font-semibold px-6 py-2 rounded-lg hover:bg-cinema-gold/90 transition-colors disabled:opacity-50"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {message && (
        <div
          className={`mb-4 px-4 py-2 rounded-lg text-sm ${
            message.type === 'success'
              ? 'bg-cinema-teal/10 text-cinema-teal border border-cinema-teal/30'
              : 'bg-red-500/10 text-red-400 border border-red-500/30'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="space-y-3">
        {results.map((movie) => (
          <div
            key={movie.id}
            className="flex items-center gap-4 bg-cinema-card border border-cinema-border rounded-lg p-3"
          >
            <div className="relative w-12 h-18 flex-shrink-0">
              {movie.poster_path ? (
                <Image
                  src={tmdbImageUrl(movie.poster_path, 'w92')}
                  alt={movie.title}
                  width={48}
                  height={72}
                  className="rounded object-cover"
                />
              ) : (
                <div className="w-12 h-18 bg-cinema-darker rounded flex items-center justify-center text-xs text-cinema-muted">
                  N/A
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-cinema-cream truncate">{movie.title}</h4>
              <p className="text-xs text-cinema-muted">
                {movie.release_date?.slice(0, 4) || 'Unknown year'} &middot; TMDB ID: {movie.id}
              </p>
            </div>
            <button
              onClick={() => handleImport(movie.id)}
              disabled={importing === movie.id}
              className="text-sm bg-cinema-teal/10 text-cinema-teal border border-cinema-teal/30 px-4 py-1.5 rounded hover:bg-cinema-teal/20 transition-colors disabled:opacity-50 flex-shrink-0"
            >
              {importing === movie.id ? 'Importing...' : 'Import'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
