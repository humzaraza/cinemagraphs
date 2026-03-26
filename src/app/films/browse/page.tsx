'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import FilmCard from '@/components/FilmCard'

interface Film {
  id: string
  title: string
  posterUrl: string | null
  releaseDate: string | null
  genres: string[]
  runtime?: number | null
  sentimentGraph?: { overallScore: number; dataPoints?: any[]; biggestSwing?: number } | null
}

const SORT_OPTIONS = [
  { value: 'az', label: 'Alphabetical A–Z' },
  { value: 'za', label: 'Alphabetical Z–A' },
  { value: 'highest', label: 'Highest Rated' },
  { value: 'swing', label: 'Biggest Sentiment Swing' },
  { value: 'recent', label: 'Most Recently Added' },
  { value: 'nowPlaying', label: 'Now Playing' },
] as const

function BrowseContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const urlGenre = searchParams.get('genre') || ''

  const [films, setFilms] = useState<Film[]>([])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<string>('az')
  const [genre, setGenre] = useState(urlGenre)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  // Sync genre from URL changes
  useEffect(() => {
    setGenre(urlGenre)
    setPage(1)
  }, [urlGenre])

  const fetchFilms = useCallback(async () => {
    setLoading(true)

    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('limit', '24')

    if (sort === 'nowPlaying') {
      params.set('sort', 'az')
      params.set('nowPlaying', 'true')
    } else {
      params.set('sort', sort)
    }

    if (genre) params.set('genre', genre)
    if (query.trim()) params.set('q', query.trim())

    const res = await fetch(`/api/films?${params}`)
    const data = await res.json()

    setFilms(data.films || [])
    setTotalPages(data.pagination?.totalPages || 1)
    setTotal(data.pagination?.total || 0)
    setLoading(false)
  }, [query, sort, genre, page])

  useEffect(() => {
    fetchFilms()
  }, [fetchFilms])

  // Reset page when filters change
  useEffect(() => {
    setPage(1)
  }, [query, sort, genre])

  const removeGenre = () => {
    setGenre('')
    // Also remove from URL
    const params = new URLSearchParams(searchParams.toString())
    params.delete('genre')
    router.replace(`/films/browse${params.toString() ? `?${params}` : ''}`)
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-10">
      <h1 className="font-[family-name:var(--font-playfair)] text-3xl font-bold mb-8">
        Browse Films
      </h1>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        {/* Search */}
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title..."
          className="flex-1 max-w-md bg-cinema-darker border border-cinema-border rounded-lg px-4 py-2.5 text-cinema-cream placeholder:text-cinema-muted focus:outline-none focus:border-cinema-gold/50"
        />

        {/* Sort dropdown */}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="bg-cinema-darker border border-cinema-border rounded-lg px-4 py-2.5 text-cinema-cream text-sm focus:outline-none focus:border-cinema-gold/50 cursor-pointer appearance-none"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23C8A951' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right 12px center',
            paddingRight: '36px',
          }}
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Active filters */}
      {genre && (
        <div className="flex items-center gap-2 mb-6">
          <span className="text-sm text-cinema-muted">Filtered by:</span>
          <button
            onClick={removeGenre}
            className="inline-flex items-center gap-1.5 text-sm bg-cinema-gold/10 text-cinema-gold border border-cinema-gold/30 px-3 py-1 rounded-full hover:bg-cinema-gold/20 transition-colors"
          >
            {genre}
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-70">
              <path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      {/* Results count */}
      {!loading && (
        <p className="text-sm text-cinema-muted mb-6">
          {total} {total === 1 ? 'film' : 'films'}{genre ? ` in ${genre}` : ''}{sort === 'nowPlaying' ? ' now playing' : ''}
        </p>
      )}

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
          {totalPages > 1 && (
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

export default function BrowsePage() {
  return (
    <Suspense fallback={<div className="max-w-7xl mx-auto px-4 py-10 text-cinema-muted">Loading...</div>}>
      <BrowseContent />
    </Suspense>
  )
}
