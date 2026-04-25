'use client'

import { useState, useEffect, useCallback } from 'react'
import { tmdbImageUrl } from '@/lib/utils'

interface FilmOption {
  id: string
  title: string
  posterUrl: string | null
  tmdbId: number
  nowPlaying: boolean
  nowPlayingOverride: string | null // null = auto, "force_show", "force_hide"
  tickerOverride: string | null     // null = auto (nowPlaying), "force_show", "force_hide"
  pinnedSection: string | null
  hasGraph: boolean
}

interface FeaturedEntry {
  filmId: string
  film: { id: string; title: string; posterUrl: string | null }
}

interface SectionVisibility {
  inTheaters: boolean
  topRated: boolean
  biggestSwings: boolean
  latestTrailers: boolean
  browseByGenre: boolean
}

const SECTION_LABELS: Record<string, string> = {
  inTheaters: 'In Theaters',
  topRated: 'Top Rated',
  biggestSwings: 'Biggest Sentiment Swings',
  latestTrailers: 'Latest Trailers',
  browseByGenre: 'Browse by Genre',
}

const PINNABLE_SECTIONS = [
  { value: 'topRated', label: 'Top Rated' },
  { value: 'biggestSwings', label: 'Biggest Swings' },
  { value: 'inTheaters', label: 'In Theaters' },
]

export default function AdminHomepageCuration({ films }: { films: FilmOption[] }) {
  const [featured, setFeatured] = useState<FeaturedEntry[]>([])
  const [visibility, setVisibility] = useState<SectionVisibility>({
    inTheaters: true,
    topRated: true,
    biggestSwings: true,
    latestTrailers: true,
    browseByGenre: true,
  })
  const [localFilms, setLocalFilms] = useState(films)
  const [featuredSearch, setFeaturedSearch] = useState('')
  const [tickerSearch, setTickerSearch] = useState('')
  const [nowPlayingSearch, setNowPlayingSearch] = useState('')
  const [pinnedSearch, setPinnedSearch] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [isFallback, setIsFallback] = useState(false)

  useEffect(() => {
    fetch('/api/admin/homepage')
      .then((r) => r.json())
      .then((data) => {
        if (data.featured) setFeatured(data.featured)
        if (data.isFallback) setIsFallback(true)
        if (data.sectionVisibility) setVisibility(data.sectionVisibility)
      })
      .catch(() => {})
  }, [])

  const flash = useCallback((msg: string) => {
    setMessage(msg)
    setTimeout(() => setMessage(null), 3000)
  }, [])

  // ── Featured Films ──
  const addFeatured = (film: FilmOption) => {
    if (featured.length >= 6) return
    if (featured.some((f) => f.filmId === film.id)) return
    setFeatured([...featured, { filmId: film.id, film: { id: film.id, title: film.title, posterUrl: film.posterUrl } }])
    setFeaturedSearch('')
  }

  const removeFeatured = (filmId: string) => {
    setFeatured(featured.filter((f) => f.filmId !== filmId))
  }

  const moveFeatured = (from: number, to: number) => {
    const updated = [...featured]
    const [moved] = updated.splice(from, 1)
    updated.splice(to, 0, moved)
    setFeatured(updated)
  }

  const saveFeatured = async () => {
    setSaving('featured')
    const res = await fetch('/api/admin/homepage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'featured', filmIds: featured.map((f) => f.filmId) }),
    })
    setSaving(null)
    if (res.ok) setIsFallback(false)
    flash(res.ok ? 'Featured films saved' : 'Failed to save')
  }

  // ── Section Visibility ──
  const toggleSection = (key: string) => {
    setVisibility((v) => ({ ...v, [key]: !v[key as keyof SectionVisibility] }))
  }

  const saveVisibility = async () => {
    setSaving('sections')
    const res = await fetch('/api/admin/homepage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sections', visibility }),
    })
    setSaving(null)
    flash(res.ok ? 'Section visibility saved' : 'Failed to save')
  }

  // ── Now Playing Override ──
  const setNowPlayingOverride = async (film: FilmOption, override: string | null) => {
    const nowPlaying = override === 'force_show' ? true : override === 'force_hide' ? false : film.nowPlaying
    const res = await fetch(`/api/admin/films/${film.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nowPlayingOverride: override, nowPlaying }),
    })
    if (res.ok) {
      setLocalFilms((prev) =>
        prev.map((f) =>
          f.id === film.id ? { ...f, nowPlayingOverride: override, nowPlaying } : f,
        ),
      )
      const label = override === 'force_show' ? 'force-shown' : override === 'force_hide' ? 'force-hidden' : 'set to auto (TMDB)'
      flash(`${film.title} ${label}`)
    }
  }

  // ── Ticker Override ──
  const setTickerOverride = async (film: FilmOption, override: string | null) => {
    const res = await fetch(`/api/admin/films/${film.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickerOverride: override }),
    })
    if (res.ok) {
      setLocalFilms((prev) =>
        prev.map((f) =>
          f.id === film.id ? { ...f, tickerOverride: override } : f,
        ),
      )
      const label = override === 'force_show' ? 'force-shown in ticker' : override === 'force_hide' ? 'hidden from ticker' : 'ticker set to auto'
      flash(`${film.title} ${label}`)
    }
  }

  // ── Pinned Section ──
  const setPinnedSection = async (film: FilmOption, section: string | null) => {
    const res = await fetch(`/api/admin/films/${film.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinnedSection: section }),
    })
    if (res.ok) {
      setLocalFilms((prev) => prev.map((f) => (f.id === film.id ? { ...f, pinnedSection: section } : f)))
      flash(section ? `${film.title} pinned to ${section}` : `${film.title} unpinned`)
    }
  }

  // Search helper: filter + sort by match quality (exact > starts-with > contains)
  function searchFilms<T extends { title: string }>(films: T[], query: string): T[] {
    const q = query.toLowerCase()
    return films
      .filter((f) => f.title.toLowerCase().includes(q))
      .sort((a, b) => {
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
  }

  const graphFilms = localFilms.filter((f) => f.hasGraph)
  const filteredFeatured = featuredSearch
    ? searchFilms(graphFilms.filter((f) => !featured.some((fe) => fe.filmId === f.id)), featuredSearch)
    : []
  const filteredTicker = tickerSearch
    ? searchFilms(localFilms, tickerSearch)
    : localFilms.filter((f) => f.nowPlaying || f.tickerOverride === 'force_show' || f.tickerOverride === 'force_hide')
  const filteredNowPlaying = nowPlayingSearch
    ? searchFilms(localFilms, nowPlayingSearch)
    : localFilms.filter((f) => f.nowPlaying || f.nowPlayingOverride === 'force_hide')
  const filteredPinned = pinnedSearch
    ? searchFilms(localFilms, pinnedSearch)
    : localFilms.filter((f) => f.pinnedSection)

  const flushHomepageCache = async () => {
    const res = await fetch('/api/admin/homepage', { method: 'DELETE' })
    flash(res.ok ? 'Homepage cache cleared — reload homepage to see changes' : 'Failed to clear cache')
  }

  return (
    <div className="space-y-10">
      {message && (
        <div className="fixed top-4 right-4 z-50 bg-cinema-gold text-cinema-dark px-4 py-2 rounded-lg font-semibold text-sm shadow-lg">
          {message}
        </div>
      )}

      {/* Cache flush button */}
      <div className="flex items-center justify-between bg-cinema-darker border border-cinema-border rounded-lg px-4 py-3">
        <div>
          <span className="text-sm text-cinema-cream font-medium">Homepage Cache</span>
          <p className="text-xs text-cinema-muted mt-0.5">Force-refresh the homepage after making changes</p>
        </div>
        <button
          onClick={flushHomepageCache}
          className="text-xs px-4 py-1.5 rounded-lg border border-cinema-gold/40 text-cinema-gold hover:bg-cinema-gold/10 transition-colors"
        >
          Refresh Cache
        </button>
      </div>

      {/* ── 1. Featured Films (Hero Carousel) ── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream">
            Featured Films (Hero Carousel)
          </h3>
          <button
            onClick={saveFeatured}
            disabled={saving === 'featured'}
            className="px-4 py-2 bg-cinema-gold text-cinema-dark rounded-lg text-sm font-semibold hover:bg-cinema-gold/90 disabled:opacity-50 transition-colors"
          >
            {saving === 'featured' ? 'Saving...' : 'Save Order'}
          </button>
        </div>
        <p className="text-xs text-cinema-muted mb-3">
          Select up to 6 films with sentiment graphs. Drag to reorder.
        </p>
        {isFallback && featured.length > 0 && (
          <div className="bg-cinema-gold/10 border border-cinema-gold/30 rounded-lg px-4 py-2 mb-3 text-xs text-cinema-gold">
            These are auto-selected (top rated). Click &quot;Save Order&quot; to lock them in, or swap films below.
          </div>
        )}

        {/* Current featured list */}
        <div className="flex gap-3 mb-4 min-h-[120px] flex-wrap">
          {featured.map((entry, i) => (
            <div
              key={entry.filmId}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null && dragIndex !== i) moveFeatured(dragIndex, i)
                setDragIndex(null)
              }}
              className="relative w-[90px] bg-cinema-darker border border-cinema-border rounded-lg overflow-hidden cursor-grab active:cursor-grabbing group"
            >
              <div className="absolute top-1 left-1 z-10 bg-cinema-gold text-cinema-dark text-xs font-bold w-5 h-5 flex items-center justify-center rounded-full">
                {i + 1}
              </div>
              <button
                onClick={() => removeFeatured(entry.filmId)}
                className="absolute top-1 right-1 z-10 bg-red-500 text-white text-xs w-5 h-5 flex items-center justify-center rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              >
                x
              </button>
              {entry.film.posterUrl ? (
                <img
                  src={tmdbImageUrl(entry.film.posterUrl, 'w200')}
                  alt={entry.film.title}
                  className="w-full h-[120px] object-cover"
                />
              ) : (
                <div className="w-full h-[120px] bg-cinema-border flex items-center justify-center text-xs text-cinema-muted p-1 text-center">
                  No poster
                </div>
              )}
              <p className="text-[10px] text-cinema-cream/80 text-center px-1 py-1 truncate">
                {entry.film.title}
              </p>
            </div>
          ))}
          {featured.length === 0 && (
            <div className="flex items-center justify-center w-full text-cinema-muted text-sm">
              No featured films selected. Search below to add.
            </div>
          )}
        </div>

        {/* Search to add */}
        <input
          type="text"
          placeholder="Search films to feature..."
          value={featuredSearch}
          onChange={(e) => setFeaturedSearch(e.target.value)}
          className="w-full bg-cinema-darker border border-cinema-border rounded-lg px-4 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted focus:outline-none focus:border-cinema-gold"
        />
        {filteredFeatured.length > 0 && (
          <div className="mt-2 max-h-48 overflow-y-auto border border-cinema-border rounded-lg divide-y divide-cinema-border">
            {filteredFeatured.slice(0, 10).map((film) => (
              <button
                key={film.id}
                onClick={() => addFeatured(film)}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-cinema-card transition-colors text-left"
              >
                {film.posterUrl && (
                  <img src={tmdbImageUrl(film.posterUrl, 'w200')} alt="" className="w-[30px] h-[45px] rounded object-cover" />
                )}
                <span className="text-sm text-cinema-cream">{film.title}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ── 2. Section Visibility ── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream">
            Section Visibility
          </h3>
          <button
            onClick={saveVisibility}
            disabled={saving === 'sections'}
            className="px-4 py-2 bg-cinema-gold text-cinema-dark rounded-lg text-sm font-semibold hover:bg-cinema-gold/90 disabled:opacity-50 transition-colors"
          >
            {saving === 'sections' ? 'Saving...' : 'Save'}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Object.entries(SECTION_LABELS).map(([key, label]) => (
            <button
              key={key}
              onClick={() => toggleSection(key)}
              className="flex items-center justify-between bg-cinema-darker border border-cinema-border rounded-lg px-4 py-3 hover:border-cinema-gold/40 transition-colors"
            >
              <span className="text-sm text-cinema-cream">{label}</span>
              <div
                className="w-10 h-5 rounded-full relative transition-colors"
                style={{ backgroundColor: visibility[key as keyof SectionVisibility] ? 'var(--cinema-gold)' : '#333' }}
              >
                <div
                  className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                  style={{ left: visibility[key as keyof SectionVisibility] ? '22px' : '2px' }}
                />
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* ── 3. Movie Market Ticker ── */}
      <section>
        <h3 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream mb-2">
          Movie Market Ticker
        </h3>
        <p className="text-xs text-cinema-muted mb-3">
          Controls which films appear in the scrolling ticker. Independent from the In Theaters section below.
        </p>
        <div className="flex gap-3 mb-3 text-[10px] text-cinema-muted">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cinema-teal" /> Auto (now playing)</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cinema-gold" /> Force shown</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> Force hidden</span>
        </div>
        <input
          type="text"
          placeholder="Search films to manage ticker..."
          value={tickerSearch}
          onChange={(e) => setTickerSearch(e.target.value)}
          className="w-full bg-cinema-darker border border-cinema-border rounded-lg px-4 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted focus:outline-none focus:border-cinema-gold mb-3"
        />
        <div className="max-h-[28rem] overflow-y-auto border border-cinema-border rounded-lg divide-y divide-cinema-border">
          {filteredTicker.map((film) => {
            const override = film.tickerOverride
            const isAuto = !override
            const isForceShow = override === 'force_show'
            const isForceHide = override === 'force_hide'
            return (
              <div key={film.id} className="flex items-center justify-between px-4 py-2.5 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      backgroundColor: isForceShow ? 'var(--cinema-gold)' : isForceHide ? '#ef4444' : 'var(--cinema-teal)',
                    }}
                  />
                  <span className={`text-sm truncate ${isForceHide ? 'text-cinema-muted line-through' : 'text-cinema-cream'}`}>
                    {film.title}
                  </span>
                  {isAuto && film.nowPlaying && (
                    <span className="text-[9px] text-cinema-teal/60 shrink-0">auto</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => setTickerOverride(film, isForceShow ? null : 'force_show')}
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                      isForceShow
                        ? 'bg-cinema-gold/20 border-cinema-gold text-cinema-gold'
                        : 'border-cinema-border text-cinema-muted hover:border-cinema-gold/40 hover:text-cinema-gold'
                    }`}
                  >
                    {isForceShow ? 'Showing' : 'Show'}
                  </button>
                  <button
                    onClick={() => setTickerOverride(film, isForceHide ? null : 'force_hide')}
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                      isForceHide
                        ? 'bg-red-500/20 border-red-500 text-red-400'
                        : 'border-cinema-border text-cinema-muted hover:border-red-500/40 hover:text-red-400'
                    }`}
                  >
                    {isForceHide ? 'Hidden' : 'Hide'}
                  </button>
                  {override && (
                    <button
                      onClick={() => setTickerOverride(film, null)}
                      className="text-[10px] px-2 py-0.5 rounded border border-cinema-border text-cinema-muted hover:border-cinema-teal/40 hover:text-cinema-teal transition-colors"
                    >
                      Auto
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {filteredTicker.length === 0 && (
            <div className="px-4 py-3 text-sm text-cinema-muted text-center">
              {tickerSearch ? 'No films found' : 'No films in ticker'}
            </div>
          )}
        </div>
      </section>

      {/* ── 4. In Theaters Section ── */}
      <section>
        <h3 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream mb-2">
          In Theaters Section
        </h3>
        <p className="text-xs text-cinema-muted mb-3">
          Controls which films appear in the &quot;In Theaters&quot; homepage section. Independent from the ticker above.
        </p>
        <div className="flex gap-3 mb-3 text-[10px] text-cinema-muted">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cinema-teal" /> Auto (TMDB)</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cinema-gold" /> Force shown</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> Force hidden</span>
        </div>
        <input
          type="text"
          placeholder="Search films to manage in theaters..."
          value={nowPlayingSearch}
          onChange={(e) => setNowPlayingSearch(e.target.value)}
          className="w-full bg-cinema-darker border border-cinema-border rounded-lg px-4 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted focus:outline-none focus:border-cinema-gold mb-3"
        />
        <div className="max-h-[28rem] overflow-y-auto border border-cinema-border rounded-lg divide-y divide-cinema-border">
          {filteredNowPlaying.map((film) => {
            const override = film.nowPlayingOverride
            const isAuto = !override
            const isForceShow = override === 'force_show'
            const isForceHide = override === 'force_hide'
            return (
              <div key={film.id} className="flex items-center justify-between px-4 py-2.5 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      backgroundColor: isForceShow ? 'var(--cinema-gold)' : isForceHide ? '#ef4444' : 'var(--cinema-teal)',
                    }}
                  />
                  <span className={`text-sm truncate ${isForceHide ? 'text-cinema-muted line-through' : 'text-cinema-cream'}`}>
                    {film.title}
                  </span>
                  {isAuto && film.nowPlaying && (
                    <span className="text-[9px] text-cinema-teal/60 shrink-0">TMDB</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => setNowPlayingOverride(film, isForceShow ? null : 'force_show')}
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                      isForceShow
                        ? 'bg-cinema-gold/20 border-cinema-gold text-cinema-gold'
                        : 'border-cinema-border text-cinema-muted hover:border-cinema-gold/40 hover:text-cinema-gold'
                    }`}
                  >
                    {isForceShow ? 'Showing' : 'Show'}
                  </button>
                  <button
                    onClick={() => setNowPlayingOverride(film, isForceHide ? null : 'force_hide')}
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                      isForceHide
                        ? 'bg-red-500/20 border-red-500 text-red-400'
                        : 'border-cinema-border text-cinema-muted hover:border-red-500/40 hover:text-red-400'
                    }`}
                  >
                    {isForceHide ? 'Hidden' : 'Hide'}
                  </button>
                  {override && (
                    <button
                      onClick={() => setNowPlayingOverride(film, null)}
                      className="text-[10px] px-2 py-0.5 rounded border border-cinema-border text-cinema-muted hover:border-cinema-teal/40 hover:text-cinema-teal transition-colors"
                    >
                      Auto
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {filteredNowPlaying.length === 0 && (
            <div className="px-4 py-3 text-sm text-cinema-muted text-center">
              {nowPlayingSearch ? 'No films found' : 'No films currently in theaters'}
            </div>
          )}
        </div>
      </section>

      {/* ── 5. Pinned Films ── */}
      <section>
        <h3 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream mb-4">
          Pinned Films
        </h3>
        <p className="text-xs text-cinema-muted mb-3">
          Pin any film to always appear first in a specific homepage section.
        </p>
        <input
          type="text"
          placeholder="Search films to pin..."
          value={pinnedSearch}
          onChange={(e) => setPinnedSearch(e.target.value)}
          className="w-full bg-cinema-darker border border-cinema-border rounded-lg px-4 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted focus:outline-none focus:border-cinema-gold mb-3"
        />
        <div className="max-h-64 overflow-y-auto border border-cinema-border rounded-lg divide-y divide-cinema-border">
          {filteredPinned.slice(0, 20).map((film) => (
            <div key={film.id} className="flex items-center justify-between px-4 py-2 gap-3">
              <span className="text-sm text-cinema-cream truncate flex-1">{film.title}</span>
              <div className="flex items-center gap-2">
                <select
                  value={film.pinnedSection ?? ''}
                  onChange={(e) => setPinnedSection(film, e.target.value || null)}
                  className="bg-cinema-darker border border-cinema-border rounded px-2 py-1 text-xs text-cinema-cream focus:outline-none focus:border-cinema-gold"
                >
                  <option value="">Not pinned</option>
                  {PINNABLE_SECTIONS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
                {film.pinnedSection && (
                  <button
                    onClick={() => setPinnedSection(film, null)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Unpin
                  </button>
                )}
              </div>
            </div>
          ))}
          {filteredPinned.length === 0 && (
            <div className="px-4 py-3 text-sm text-cinema-muted text-center">
              {pinnedSearch ? 'No films found' : 'No pinned films'}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
