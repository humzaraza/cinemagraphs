'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'

type Format = '4x5' | '9x16'

interface FilmResult {
  id: string
  title: string
  releaseDate: string | null
  posterUrl: string | null
  sentimentGraph: { overallScore: number } | null
}

interface DraftSlide {
  slideNumber: number
  pngBase64: string
  widthPx: number
  heightPx: number
}

interface DraftResponse {
  film: {
    id: string
    title: string
    year: number | null
    runtimeMinutes: number
    genres: string[]
    criticsScore: number
  }
  format: Format
  cached: boolean
  generatedAt: string
  generatedAtModel: string
  slides: DraftSlide[]
}

const SLIDE_LABELS: Record<number, string> = {
  1: 'Hook',
  2: 'The Opening',
  3: 'The Setup',
  4: 'The Drop',
  5: 'First Contact',
  6: 'The Peak',
  7: 'The Ending',
  8: 'Takeaway',
}

const LOADING_MESSAGES = [
  'Picking story beats...',
  'Drafting body copy...',
  'Composing slides...',
] as const

const FORMAT_OPTIONS: { value: Format; label: string }[] = [
  { value: '4x5', label: '4:5' },
  { value: '9x16', label: '9:16' },
]

export default function CarouselSharePage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FilmResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedFilm, setSelectedFilm] = useState<FilmResult | null>(null)
  const [format, setFormat] = useState<Format>('4x5')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DraftResponse | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (status === 'authenticated' && session?.user?.role !== 'ADMIN') {
      router.replace('/auth/signin')
    }
  }, [status, session, router])

  // Cycle loading messages every 3s while loading.
  useEffect(() => {
    if (!loading) {
      setLoadingMsgIdx(0)
      return
    }
    const id = setInterval(() => {
      setLoadingMsgIdx((i) => (i + 1) % LOADING_MESSAGES.length)
    }, 3000)
    return () => clearInterval(id)
  }, [loading])

  const searchFilms = useCallback(async (q: string) => {
    if (q.trim().length === 0) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      const res = await fetch(`/api/films/search?q=${encodeURIComponent(q)}`)
      if (res.ok) {
        const json = await res.json()
        setResults(json.films ?? [])
      }
    } catch {
      // silently fail
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => searchFilms(query), 300)
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current) }
  }, [query, searchFilms])

  const loadDraft = useCallback(
    async (filmId: string, fmt: Format) => {
      setLoading(true)
      setError(null)
      setData(null)
      setElapsedMs(null)
      const t0 = performance.now()
      try {
        const res = await fetch('/api/admin/carousel/draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filmId, format: fmt }),
        })
        const text = await res.text()
        if (!res.ok) {
          try {
            const json = JSON.parse(text)
            setError(json.error || 'Failed to load draft')
          } catch {
            setError('Failed to load draft')
          }
          return
        }
        const json = JSON.parse(text) as DraftResponse
        setData(json)
        setElapsedMs(Math.round(performance.now() - t0))
      } catch {
        setError('Failed to load draft')
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  function selectFilm(film: FilmResult) {
    setQuery('')
    setResults([])
    setSelectedFilm(film)
    loadDraft(film.id, format)
  }

  function changeFormat(next: Format) {
    if (next === format) return
    setFormat(next)
    if (selectedFilm) {
      loadDraft(selectedFilm.id, next)
    }
  }

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-cinema-dark flex items-center justify-center">
        <span className="text-cinema-muted">Loading...</span>
      </div>
    )
  }

  if (session?.user?.role !== 'ADMIN') return null

  return (
    <div className="min-h-screen bg-cinema-dark text-cinema-cream">
      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="font-[family-name:var(--font-playfair)] text-2xl mb-1">
            Carousel Preview
          </h1>
          <p className="text-sm text-cinema-muted">
            Read-only preview. Editing comes in next phase.
          </p>
        </div>

        {/* Film search */}
        <div className="relative mb-4">
          <label className="text-xs text-cinema-muted block mb-1">Select film</label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search films..."
            className="w-full bg-[#1a1a2e] border border-[#333] rounded-lg px-3 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/50"
          />
          {results.length > 0 && (
            <div className="absolute z-20 top-full mt-1 w-full bg-[#1a1a2e] border border-[#333] rounded-lg max-h-64 overflow-y-auto shadow-xl">
              {results.map((film) => (
                <button
                  key={film.id}
                  onClick={() => selectFilm(film)}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-white/5 transition-colors"
                >
                  {film.posterUrl && (
                    <Image
                      src={`https://image.tmdb.org/t/p/w92${film.posterUrl}`}
                      alt=""
                      width={28}
                      height={42}
                      unoptimized
                      className="rounded"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-cinema-cream truncate block">{film.title}</span>
                    <span className="text-xs text-cinema-muted">
                      {film.releaseDate ? new Date(film.releaseDate).getFullYear() : ''}
                      {film.sentimentGraph && ` · ${film.sentimentGraph.overallScore.toFixed(1)}`}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
          {searching && (
            <div className="absolute right-3 top-[calc(50%+8px)] -translate-y-1/2">
              <span className="text-xs text-cinema-muted">...</span>
            </div>
          )}
        </div>

        {/* Format toggle */}
        <div className="mb-6">
          <label className="text-xs text-cinema-muted block mb-1.5">Format</label>
          <div className="flex gap-2">
            {FORMAT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => changeFormat(opt.value)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                  format === opt.value
                    ? 'border-cinema-gold/50 text-cinema-gold bg-cinema-gold/10'
                    : 'border-[#333] text-cinema-muted hover:text-cinema-cream hover:border-cinema-gold/30'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="bg-[#1a1a2e] border border-[#333] rounded-lg px-4 py-8 text-center">
            <span className="text-sm text-cinema-muted">{LOADING_MESSAGES[loadingMsgIdx]}</span>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
            <span className="text-sm text-red-300">{error}</span>
          </div>
        )}

        {/* Status row + slides */}
        {data && !loading && (
          <>
            <div className="bg-[#1a1a2e] border border-[#333] rounded-lg px-4 py-3 mb-4">
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="font-[family-name:var(--font-playfair)] text-lg text-cinema-cream">
                  {data.film.title}
                </span>
                {data.film.year && (
                  <span className="text-sm text-cinema-muted">{data.film.year}</span>
                )}
                <span className="text-sm text-cinema-gold">
                  {data.film.criticsScore.toFixed(1)}
                </span>
              </div>
              <div className="text-xs text-cinema-muted mt-1">
                {data.format} ·{' '}
                {data.cached ? (
                  <span className="text-cinema-teal">cached</span>
                ) : (
                  <span className="text-cinema-gold">generated</span>
                )}
                {elapsedMs !== null && ` · ${(elapsedMs / 1000).toFixed(1)}s`}
                {` · ${data.generatedAtModel}`}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              {data.slides.map((s) => (
                <div key={s.slideNumber}>
                  <div className="text-xs text-cinema-muted mb-1.5">
                    Slide {s.slideNumber} — {SLIDE_LABELS[s.slideNumber] ?? ''}
                  </div>
                  <div className="bg-[#0D0D1A] border border-[#333] rounded-lg overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:image/png;base64,${s.pngBase64}`}
                      alt={`Slide ${s.slideNumber}`}
                      width={s.widthPx}
                      height={s.heightPx}
                      className="block w-full h-auto"
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
