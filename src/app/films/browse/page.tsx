'use client'

import { useState, useEffect, useCallback } from 'react'
import FilmCard from '@/components/FilmCard'

interface Film {
  id: string
  title: string
  posterUrl: string | null
  releaseDate: string | null
  genres: string[]
  runtime?: number | null
  sentimentGraph?: { overallScore: number; dataPoints?: any[] } | null
}

export default function BrowsePage() {
  const [films, setFilms] = useState<Film[]>([])
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)

  const fetchFilms = useCallback(async () => {
    setLoading(true)
    const url = query.trim()
      ? `/api/films/search?q=${encodeURIComponent(query.trim())}`
      : `/api/films?page=${page}&limit=24`

    const res = await fetch(url)
    const data = await res.json()

    if (query.trim()) {
      setFilms(data.films || [])
      setTotalPages(1)
    } else {
      setFilms(data.films || [])
      setTotalPages(data.pagination?.totalPages || 1)
    }
    setLoading(false)
  }, [query, page])

  useEffect(() => {
    fetchFilms()
  }, [fetchFilms])

  useEffect(() => {
    setPage(1)
  }, [query])

  return (
    <div className="max-w-7xl mx-auto px-4 py-10">
      <h1 className="font-[family-name:var(--font-playfair)] text-3xl font-bold mb-8">
        Browse Films
      </h1>

      {/* Search */}
      <div className="mb-8">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title..."
          className="w-full max-w-md bg-cinema-darker border border-cinema-border rounded-lg px-4 py-2.5 text-cinema-cream placeholder:text-cinema-muted focus:outline-none focus:border-cinema-gold/50"
        />
      </div>

      {loading ? (
        <div className="text-center py-20 text-cinema-muted">Loading...</div>
      ) : films.length === 0 ? (
        <div className="text-center py-20 text-cinema-muted">
          {query ? 'No films match your search.' : 'No films available yet.'}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {films.map((film) => (
              <FilmCard
                key={film.id}
                id={film.id}
                title={film.title}
                posterUrl={film.posterUrl}
                releaseDate={film.releaseDate}
                genres={film.genres}
                sentimentScore={film.sentimentGraph?.overallScore}
                graphDataPoints={film.sentimentGraph?.dataPoints ?? null}
                runtime={film.runtime}
              />
            ))}
          </div>

          {/* Pagination */}
          {!query && totalPages > 1 && (
            <div className="flex justify-center gap-3 mt-10">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-4 py-2 rounded bg-cinema-card border border-cinema-border text-sm disabled:opacity-30 hover:border-cinema-gold/50 transition-colors"
              >
                Previous
              </button>
              <span className="px-4 py-2 text-sm text-cinema-muted">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-4 py-2 rounded bg-cinema-card border border-cinema-border text-sm disabled:opacity-30 hover:border-cinema-gold/50 transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
