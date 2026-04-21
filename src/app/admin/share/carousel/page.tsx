'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { selectBeatSlots, type BeatSlot, type Beat } from '@/lib/carousel/slot-selection'

interface FilmResult {
  id: string
  title: string
  releaseDate: string | null
  posterUrl: string | null
  sentimentGraph: { overallScore: number } | null
}

interface PrepareResponse {
  film: {
    id: string
    title: string
    year: number | null
    runtimeMinutes: number
    genres: string[]
    criticsScore: number
  }
  beats: Beat[]
  backdrops: string[]
}

export default function CarouselSharePage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FilmResult[]>([])
  const [searching, setSearching] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<PrepareResponse | null>(null)
  const [slots, setSlots] = useState<BeatSlot[]>([])
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (status === 'authenticated' && session?.user?.role !== 'ADMIN') {
      router.replace('/auth/signin')
    }
  }, [status, session, router])

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

  async function selectFilm(film: FilmResult) {
    setQuery('')
    setResults([])
    setLoading(true)
    setError(null)
    setData(null)
    setSlots([])
    try {
      const res = await fetch('/api/admin/carousel/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filmId: film.id }),
      })
      if (!res.ok) {
        const text = await res.text()
        try {
          const json = JSON.parse(text)
          setError(json.error || 'Failed to load film')
        } catch {
          setError('Failed to load film')
        }
        return
      }
      const json = (await res.json()) as PrepareResponse
      setData(json)
      setSlots(selectBeatSlots(json.beats, json.film.runtimeMinutes))
    } catch {
      setError('Failed to load film')
    } finally {
      setLoading(false)
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
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="font-[family-name:var(--font-playfair)] text-2xl mb-1">
            Carousel Generator
          </h1>
          <p className="text-sm text-cinema-muted">
            8-slide Beat by Beat carousel — Phase A: slot selection verification
          </p>
        </div>

        {/* Film search */}
        <div className="relative mb-6">
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

        {loading && <p className="text-sm text-cinema-muted">Loading beats…</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        {data && slots.length > 0 && (
          <div className="space-y-4">
            {/* Film summary */}
            <div className="bg-[#1a1a2e] border border-[#333] rounded-lg px-4 py-3">
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
                <span className="text-sm text-cinema-muted">
                  · {data.film.runtimeMinutes}m · {data.film.genres.join(', ')}
                </span>
              </div>
              <div className="text-xs text-cinema-muted mt-1">
                {data.beats.length} beats · {data.backdrops.length} backdrops available
              </div>
            </div>

            {/* Verification table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#333] text-xs uppercase tracking-wide text-cinema-muted">
                    <th className="text-left py-2 px-3 font-normal">#</th>
                    <th className="text-left py-2 px-3 font-normal">Kind</th>
                    <th className="text-left py-2 px-3 font-normal">Time</th>
                    <th className="text-left py-2 px-3 font-normal">Score</th>
                    <th className="text-left py-2 px-3 font-normal">Label</th>
                    <th className="text-left py-2 px-3 font-normal">Collision?</th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map((slot) => (
                    <tr
                      key={slot.position}
                      className={`border-b border-[#222] ${slot.collision ? 'bg-red-500/5' : ''}`}
                    >
                      <td className="py-2 px-3 font-bold text-cinema-gold">{slot.position}</td>
                      <td className="py-2 px-3 text-cinema-cream">{slot.kind}</td>
                      <td className="py-2 px-3 text-cinema-muted">
                        {slot.beat ? slot.timestampLabel : '—'}
                      </td>
                      <td className="py-2 px-3 text-cinema-muted">
                        {slot.beat ? slot.beat.score.toFixed(2) : '—'}
                      </td>
                      <td className="py-2 px-3 text-cinema-cream">
                        {slot.beat ? (slot.beat.labelFull ?? slot.beat.label) : <span className="text-cinema-muted italic">placeholder</span>}
                      </td>
                      <td className="py-2 px-3">
                        {slot.collision ? (
                          <span className="text-red-400">yes</span>
                        ) : (
                          <span className="text-cinema-muted">no</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
