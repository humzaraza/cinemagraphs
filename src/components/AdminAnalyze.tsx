'use client'

import { useState } from 'react'

interface Film {
  id: string
  title: string
  hasGraph: boolean
  reviewCount: number
  graphDate: string | null
  graphDateRaw: string | null
  createdAt: string
}

type SortOption = 'recent' | 'title-asc' | 'title-desc' | 'reviews' | 'analyzed'

export default function AdminAnalyze({ films: initialFilms }: { films: Film[] }) {
  const [films, setFilms] = useState(initialFilms)
  const [analyzing, setAnalyzing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [results, setResults] = useState<Record<string, 'success' | 'error' | 'pending'>>({})
  const [message, setMessage] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortOption>('recent')
  const [search, setSearch] = useState('')

  async function analyzeFilm(filmId: string) {
    setAnalyzing(filmId)
    setMessage('')
    try {
      const res = await fetch(`/api/admin/films/${filmId}/analyze`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed')
      }
      setResults((prev) => ({ ...prev, [filmId]: 'success' }))
      setMessage('Analysis complete! Refresh to see the graph.')
    } catch (err) {
      setResults((prev) => ({ ...prev, [filmId]: 'error' }))
      setMessage(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setAnalyzing(null)
    }
  }

  async function analyzeAll() {
    setBatchRunning(true)
    setMessage('Running batch analysis... this may take several minutes.')
    const filmIds = films.filter((f) => !f.hasGraph).map((f) => f.id)
    if (filmIds.length === 0) {
      setMessage('All films already have graphs!')
      setBatchRunning(false)
      return
    }

    try {
      const res = await fetch('/api/admin/films/analyze-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filmIds }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Batch failed')

      for (const id of data.succeeded || []) {
        setResults((prev) => ({ ...prev, [id]: 'success' }))
      }
      for (const item of data.failed || []) {
        setResults((prev) => ({ ...prev, [item.id]: 'error' }))
      }
      setMessage(
        `Batch complete: ${data.succeeded?.length || 0} succeeded, ${data.failed?.length || 0} failed`
      )
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Batch failed')
    } finally {
      setBatchRunning(false)
    }
  }

  async function deleteFilm(film: Film) {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${film.title}"? This will also delete its sentiment graph and all associated reviews.`
    )
    if (!confirmed) return

    setDeleting(film.id)
    try {
      const res = await fetch(`/api/admin/films/${film.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to delete')
      }
      setFilms((prev) => prev.filter((f) => f.id !== film.id))
      setToast(`"${film.title}" deleted successfully`)
      setTimeout(() => setToast(null), 3000)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  const sortedFilms = [...films].sort((a, b) => {
    switch (sortBy) {
      case 'title-asc':
        return a.title.localeCompare(b.title)
      case 'title-desc':
        return b.title.localeCompare(a.title)
      case 'reviews':
        return b.reviewCount - a.reviewCount
      case 'analyzed':
        return (b.graphDateRaw ?? '').localeCompare(a.graphDateRaw ?? '')
      case 'recent':
      default:
        return b.createdAt.localeCompare(a.createdAt)
    }
  })

  // Apply search filter with priority: exact > starts-with > contains
  const displayedFilms = search
    ? sortedFilms
        .filter((f) => f.title.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => {
          const q = search.toLowerCase()
          const aLower = a.title.toLowerCase()
          const bLower = b.title.toLowerCase()
          const aExact = aLower === q
          const bExact = bLower === q
          if (aExact !== bExact) return aExact ? -1 : 1
          const aStarts = aLower.startsWith(q)
          const bStarts = bLower.startsWith(q)
          if (aStarts !== bStarts) return aStarts ? -1 : 1
          return 0
        })
    : sortedFilms

  const filmsWithoutGraphs = films.filter((f) => !f.hasGraph).length

  return (
    <div>
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-cinema-gold text-cinema-dark px-4 py-2 rounded-lg font-semibold text-sm shadow-lg">
          {toast}
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <p className="text-sm text-cinema-muted">
            {films.length - filmsWithoutGraphs} / {films.length} films have sentiment graphs
          </p>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search films..."
            style={{
              background: '#1a1a2e',
              border: '0.5px solid #333',
              color: '#e0e0e0',
              borderRadius: 6,
              fontSize: 13,
              padding: '4px 10px',
              outline: 'none',
              width: 180,
            }}
          />
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: '#888' }}>Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              style={{
                background: '#1a1a2e',
                border: '0.5px solid #333',
                color: '#e0e0e0',
                borderRadius: 6,
                fontSize: 13,
                padding: '4px 8px',
                outline: 'none',
              }}
            >
              <option value="recent">Recently added</option>
              <option value="title-asc">Title (A-Z)</option>
              <option value="title-desc">Title (Z-A)</option>
              <option value="reviews">Most reviews</option>
              <option value="analyzed">Last analyzed</option>
            </select>
          </div>
        </div>
        {filmsWithoutGraphs > 0 && (
          <button
            onClick={analyzeAll}
            disabled={batchRunning}
            className="px-4 py-2 bg-cinema-teal/20 text-cinema-teal border border-cinema-teal/30 rounded-lg text-sm hover:bg-cinema-teal/30 disabled:opacity-50 transition-colors"
          >
            {batchRunning ? 'Analyzing...' : `Generate All (${filmsWithoutGraphs})`}
          </button>
        )}
      </div>

      {message && (
        <div className="mb-4 p-3 rounded-lg bg-cinema-card border border-cinema-border text-sm text-cinema-cream">
          {message}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cinema-border text-left text-cinema-muted">
              <th className="py-2 pr-4">Title</th>
              <th className="py-2 pr-4">Graph</th>
              <th className="py-2 pr-4">Reviews</th>
              <th className="py-2 pr-4">Last Analyzed</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {displayedFilms.map((film) => (
              <tr key={film.id} className="border-b border-cinema-border/50">
                <td className="py-2 pr-4 text-cinema-cream">{film.title}</td>
                <td className="py-2 pr-4">
                  {results[film.id] === 'success' || film.hasGraph ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-cinema-teal/10 text-cinema-teal">
                      Ready
                    </span>
                  ) : results[film.id] === 'error' ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-400">
                      Failed
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded bg-cinema-muted/10 text-cinema-muted">
                      None
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-cinema-muted">{film.reviewCount}</td>
                <td className="py-2 pr-4 text-cinema-muted text-xs">
                  {film.graphDate || '—'}
                </td>
                <td className="py-2">
                  <div className="flex gap-2">
                    <button
                      onClick={() => analyzeFilm(film.id)}
                      disabled={analyzing === film.id || batchRunning}
                      className="text-xs px-3 py-1 bg-cinema-gold/10 text-cinema-gold border border-cinema-gold/20 rounded hover:bg-cinema-gold/20 disabled:opacity-50 transition-colors"
                    >
                      {analyzing === film.id ? 'Analyzing...' : film.hasGraph ? 'Regenerate' : 'Generate'}
                    </button>
                    <button
                      onClick={() => deleteFilm(film)}
                      disabled={deleting === film.id}
                      className="text-xs px-3 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded hover:bg-red-500/20 disabled:opacity-50 transition-colors"
                    >
                      {deleting === film.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
