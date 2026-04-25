'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'

interface FilmResult {
  id: string
  title: string
  releaseDate: string | null
  posterUrl: string | null
  sentimentGraph: { overallScore: number } | null
}

type TitleDisplay = 'logo' | 'font'
type AspectRatio = '16:9' | '1:1' | '4:5' | '9:16'

const RATIO_OPTIONS: { value: AspectRatio; label: string }[] = [
  { value: '16:9', label: 'Twitter/X (16:9)' },
  { value: '1:1', label: 'Instagram Square (1:1)' },
  { value: '4:5', label: 'Instagram Portrait (4:5)' },
  { value: '9:16', label: 'TikTok (9:16)' },
]

interface SelectedFilm {
  id: string
  title: string
  year: string
  posterUrl: string | null
  score: number | null
  titleDisplay: TitleDisplay
  cropY: number
}

export default function ShareListPage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FilmResult[]>([])
  const [searching, setSearching] = useState(false)
  const [films, setFilms] = useState<SelectedFilm[]>([])
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [generating, setGenerating] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [ratio, setRatio] = useState<AspectRatio>('16:9')
  const [copied, setCopied] = useState(false)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cropTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Admin gate
  useEffect(() => {
    if (status === 'authenticated' && session?.user?.role !== 'ADMIN') {
      router.replace('/auth/signin')
    }
  }, [status, session, router])

  // Debounced search
  const searchFilms = useCallback(async (q: string) => {
    if (q.trim().length === 0) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      const res = await fetch(`/api/films/search?q=${encodeURIComponent(q)}`)
      if (res.ok) {
        const data = await res.json()
        setResults(data.films ?? [])
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

  function addFilm(film: FilmResult) {
    if (films.length >= 15) return
    if (films.some((f) => f.id === film.id)) return
    const year = film.releaseDate ? new Date(film.releaseDate).getFullYear().toString() : ''
    setFilms((prev) => [
      ...prev,
      {
        id: film.id,
        title: film.title,
        year,
        posterUrl: film.posterUrl,
        score: film.sentimentGraph?.overallScore ?? null,
        titleDisplay: 'logo',
        cropY: 30,
      },
    ])
    setQuery('')
    setResults([])
  }

  function removeFilm(id: string) {
    setFilms((prev) => prev.filter((f) => f.id !== id))
  }

  function toggleTitleDisplay(id: string) {
    setFilms((prev) =>
      prev.map((f) =>
        f.id === id ? { ...f, titleDisplay: f.titleDisplay === 'logo' ? 'font' : 'logo' } : f
      )
    )
  }

  function setAllTitleDisplay(display: TitleDisplay) {
    setFilms((prev) => prev.map((f) => ({ ...f, titleDisplay: display })))
  }

  function setCropY(id: string, value: number) {
    setFilms((prev) => {
      const updated = prev.map((f) => (f.id === id ? { ...f, cropY: value } : f))
      // Debounced auto-regenerate if preview exists
      if (cropTimeout.current) clearTimeout(cropTimeout.current)
      cropTimeout.current = setTimeout(() => {
        regeneratePreview(updated)
      }, 300)
      return updated
    })
  }

  async function regeneratePreview(currentFilms: SelectedFilm[]) {
    if (currentFilms.length === 0) return
    setGenerating(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        films: currentFilms.map((f) => f.id).join(','),
        title: title || 'Top Films',
        subtitle: subtitle || '',
        displays: currentFilms.map((f) => f.titleDisplay).join(','),
        crops: currentFilms.map((f) => f.cropY).join(','),
        ratio,
      })
      const res = await fetch(`/api/og/list?${params}`)
      if (!res.ok) {
        const text = await res.text()
        try {
          const data = JSON.parse(text)
          setError(data.error || 'Failed to generate poster')
        } catch {
          setError('Failed to generate poster')
        }
        return
      }
      const blob = await res.blob()
      setPreviewUrl(URL.createObjectURL(blob))
    } catch {
      setError('Failed to generate poster')
    } finally {
      setGenerating(false)
    }
  }

  // Drag handlers
  function handleDragStart(index: number) {
    setDragIndex(index)
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    setDragOverIndex(index)
  }

  function handleDrop(index: number) {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null)
      setDragOverIndex(null)
      return
    }
    setFilms((prev) => {
      const updated = [...prev]
      const [moved] = updated.splice(dragIndex, 1)
      updated.splice(index, 0, moved)
      return updated
    })
    setDragIndex(null)
    setDragOverIndex(null)
  }

  function handleDragEnd() {
    setDragIndex(null)
    setDragOverIndex(null)
  }

  function buildParams() {
    return new URLSearchParams({
      films: films.map((f) => f.id).join(','),
      title: title || 'Top Films',
      subtitle: subtitle || '',
      displays: films.map((f) => f.titleDisplay).join(','),
      crops: films.map((f) => f.cropY).join(','),
      ratio,
    })
  }

  async function generatePoster() {
    if (films.length === 0) return
    setGenerating(true)
    setError(null)
    setPreviewUrl(null)

    try {
      const res = await fetch(`/api/og/list?${buildParams()}`)
      if (!res.ok) {
        const text = await res.text()
        try {
          const data = JSON.parse(text)
          setError(data.error || 'Failed to generate poster')
        } catch {
          setError('Failed to generate poster')
        }
        return
      }
      const blob = await res.blob()
      setPreviewUrl(URL.createObjectURL(blob))
    } catch {
      setError('Failed to generate poster')
    } finally {
      setGenerating(false)
    }
  }

  function downloadPoster() {
    if (!previewUrl) return
    const a = document.createElement('a')
    a.href = previewUrl
    a.download = `cinemagraphs-${title.toLowerCase().replace(/\s+/g, '-') || 'list'}.png`
    a.click()
  }

  function copyShareLink() {
    const url = `${window.location.origin}/api/og/list?${buildParams()}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
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
        {/* Header */}
        <div className="mb-8">
          <h1 className="font-[family-name:var(--font-playfair)] text-2xl mb-1">
            Ranked Film List Poster
          </h1>
          <p className="text-sm text-cinema-muted">Generate a shareable ranked poster image</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left: Builder */}
          <div className="space-y-6">
            {/* Title & Subtitle */}
            <div className="space-y-3">
              <div>
                <label className="text-xs text-cinema-muted block mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Christopher Nolan"
                  className="w-full bg-cinema-card border border-[#333] rounded-lg px-3 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/50"
                />
              </div>
              <div>
                <label className="text-xs text-cinema-muted block mb-1">Subtitle</label>
                <input
                  type="text"
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  placeholder="Every film ranked by emotional arc"
                  className="w-full bg-cinema-card border border-[#333] rounded-lg px-3 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/50"
                />
              </div>
            </div>

            {/* Aspect Ratio */}
            <div>
              <label className="text-xs text-cinema-muted block mb-1.5">Aspect Ratio</label>
              <div className="flex gap-2">
                {RATIO_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setRatio(opt.value)}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      ratio === opt.value
                        ? 'border-cinema-gold/50 text-cinema-gold bg-cinema-gold/10'
                        : 'border-[#333] text-cinema-muted hover:text-cinema-cream hover:border-cinema-gold/30'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Search */}
            <div className="relative">
              <label className="text-xs text-cinema-muted block mb-1">
                Add films ({films.length}/15)
              </label>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search films..."
                disabled={films.length >= 15}
                className="w-full bg-cinema-card border border-[#333] rounded-lg px-3 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/50 disabled:opacity-40"
              />
              {results.length > 0 && (
                <div className="absolute z-20 top-full mt-1 w-full bg-cinema-card border border-[#333] rounded-lg max-h-64 overflow-y-auto shadow-xl">
                  {results
                    .filter((r) => !films.some((f) => f.id === r.id))
                    .map((film) => (
                      <button
                        key={film.id}
                        onClick={() => addFilm(film)}
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
                          <span className="text-sm text-cinema-cream truncate block">
                            {film.title}
                          </span>
                          <span className="text-xs text-cinema-muted">
                            {film.releaseDate
                              ? new Date(film.releaseDate).getFullYear()
                              : ''}
                            {film.sentimentGraph &&
                              ` · ${film.sentimentGraph.overallScore.toFixed(1)}`}
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

            {/* Draggable film list */}
            {films.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-cinema-muted">
                    Drag to reorder ranking
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-cinema-muted/60">Select all:</span>
                    <button
                      onClick={() => setAllTitleDisplay('logo')}
                      className="text-[10px] px-2 py-0.5 rounded border border-[#333] text-cinema-muted hover:text-cinema-cream hover:border-cinema-gold/30 transition-colors"
                    >
                      Logo
                    </button>
                    <button
                      onClick={() => setAllTitleDisplay('font')}
                      className="text-[10px] px-2 py-0.5 rounded border border-[#333] text-cinema-muted hover:text-cinema-cream hover:border-cinema-gold/30 transition-colors"
                    >
                      Font
                    </button>
                  </div>
                </div>
                {films.map((film, i) => (
                  <div
                    key={film.id}
                    draggable
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={(e) => handleDragOver(e, i)}
                    onDrop={() => handleDrop(i)}
                    onDragEnd={handleDragEnd}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-grab active:cursor-grabbing transition-all ${
                      dragOverIndex === i
                        ? 'border-cinema-gold/50 bg-cinema-gold/5'
                        : 'border-[#333] bg-cinema-card'
                    } ${dragIndex === i ? 'opacity-40' : ''}`}
                  >
                    <span className="text-sm font-bold text-cinema-gold w-6 text-center flex-shrink-0">
                      {i + 1}
                    </span>
                    <span className="text-sm text-cinema-cream flex-1 truncate">
                      {film.title}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleTitleDisplay(film.id) }}
                      className={`text-[10px] px-2 py-0.5 rounded flex-shrink-0 border transition-colors ${
                        film.titleDisplay === 'logo'
                          ? 'border-cinema-teal/40 text-cinema-teal bg-cinema-teal/10'
                          : 'border-cinema-gold/40 text-cinema-gold bg-cinema-gold/10'
                      }`}
                    >
                      {film.titleDisplay === 'logo' ? 'Logo' : 'Font'}
                    </button>
                    <div className="flex items-center gap-1 flex-shrink-0" title="Backdrop crop">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={film.cropY}
                        onChange={(e) => { e.stopPropagation(); setCropY(film.id, Number(e.target.value)) }}
                        className="w-12 h-1 accent-cinema-teal cursor-pointer"
                      />
                      <input
                        type="text"
                        inputMode="numeric"
                        value={film.cropY}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation()
                          const raw = e.target.value.replace(/[^0-9]/g, '')
                          if (raw === '') { setCropY(film.id, 0); return }
                          const num = Math.max(0, Math.min(100, Number(raw)))
                          setCropY(film.id, num)
                        }}
                        className="w-7 text-[10px] text-cinema-muted text-right bg-transparent border-b border-[#333] focus:border-cinema-teal/50 focus:text-cinema-cream outline-none px-0"
                      />
                      <span className="text-[10px] text-cinema-muted">%</span>
                    </div>
                    <span className="text-xs text-cinema-muted flex-shrink-0">
                      {film.year}
                    </span>
                    {film.score != null && (
                      <span className="text-xs text-cinema-gold flex-shrink-0">
                        {film.score.toFixed(1)}
                      </span>
                    )}
                    <button
                      onClick={() => removeFilm(film.id)}
                      className="text-red-400/60 hover:text-red-400 text-xs flex-shrink-0 ml-1"
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={generatePoster}
                disabled={films.length === 0 || generating}
                className="px-5 py-2.5 bg-cinema-gold/20 text-cinema-gold border border-cinema-gold/30 rounded-lg text-sm font-medium hover:bg-cinema-gold/30 disabled:opacity-40 transition-colors"
              >
                {generating ? 'Generating...' : 'Generate Poster'}
              </button>
              {films.length > 0 && (
                <button
                  onClick={copyShareLink}
                  className="px-4 py-2.5 bg-white/5 text-cinema-muted border border-[#333] rounded-lg text-sm hover:bg-white/10 transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy Link'}
                </button>
              )}
            </div>

            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}
          </div>

          {/* Right: Preview */}
          <div>
            {previewUrl ? (
              <div className="space-y-3">
                <div className="rounded-lg overflow-hidden border border-[#333] shadow-xl">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl} alt="Generated poster" className="w-full" />
                </div>
                <button
                  onClick={downloadPoster}
                  className="w-full px-4 py-2.5 bg-cinema-teal/20 text-cinema-teal border border-cinema-teal/30 rounded-lg text-sm font-medium hover:bg-cinema-teal/30 transition-colors"
                >
                  Download PNG
                </button>
              </div>
            ) : (
              <div className={`rounded-lg border border-[#333] bg-cinema-card flex items-center justify-center text-cinema-muted/40 text-sm ${
                ratio === '16:9' ? 'aspect-[16/9]' : ratio === '1:1' ? 'aspect-square' : ratio === '4:5' ? 'aspect-[4/5]' : 'aspect-[9/16]'
              }`}>
                {generating ? 'Generating poster...' : 'Poster preview will appear here'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
