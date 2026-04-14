'use client'

import { useState } from 'react'

interface Film {
  id: string
  title: string
  hasGraph: boolean
  hasBeats: boolean
  beatSource: 'graph' | 'wikipedia' | 'none'
  reviewCount: number
  graphDate: string | null
  graphDateRaw: string | null
  createdAt: string
}

type SortOption = 'recent' | 'title-asc' | 'title-desc' | 'reviews' | 'analyzed'

// Coarse eligibility for the "Generate Missing Graphs" button. The server
// does the real quality-review check (see generate-missing-graphs/route.ts);
// this is just the client-side count shown in the button label, based on
// total review count which is all we have in the Film type. Films with 3+
// total reviews but <3 quality reviews will be skipped server-side and
// counted under `skipped` in the final summary.
const MIN_REVIEWS_FOR_MISSING_GRAPHS = 3

interface MissingGraphsProgress {
  n: number
  total: number
  title: string
}

interface MissingGraphsSummary {
  total: number
  processed: number
  succeeded: number
  failed: number
  timedOut: boolean
  stoppedAtTitle: string | null
}

// Discriminated union of SSE events from /api/admin/films/generate-missing-graphs.
type MissingGraphsEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; n: number; total: number; title: string; filmId: string }
  | { type: 'result'; filmId: string; title: string; ok: boolean; error?: string }
  | { type: 'timeout'; stoppedAtTitle: string; processed: number; total: number }
  | {
      type: 'done'
      total: number
      processed: number
      succeeded: number
      failed: number
      timedOut: boolean
      stoppedAtTitle: string | null
      durationMs: number
    }

export default function AdminAnalyze({ films: initialFilms }: { films: Film[] }) {
  const [films, setFilms] = useState(initialFilms)
  const [analyzing, setAnalyzing] = useState<string | null>(null)
  const [generatingBeats, setGeneratingBeats] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [beatsBatchRunning, setBeatsBatchRunning] = useState(false)
  const [missingGraphsRunning, setMissingGraphsRunning] = useState(false)
  const [missingGraphsProgress, setMissingGraphsProgress] =
    useState<MissingGraphsProgress | null>(null)
  const [missingGraphsSummary, setMissingGraphsSummary] =
    useState<MissingGraphsSummary | null>(null)
  const [results, setResults] = useState<Record<string, 'success' | 'error' | 'pending'>>({})
  const [beatResults, setBeatResults] = useState<Record<string, 'success' | 'error'>>({})
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

  async function generateWikiBeats(filmId: string, force: boolean = false) {
    setGeneratingBeats(filmId)
    setMessage('')
    try {
      const res = await fetch(`/api/admin/films/${filmId}/generate-wiki-beats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')

      if (data.status === 'generated') {
        setBeatResults((prev) => ({ ...prev, [filmId]: 'success' }))
        setFilms((prev) =>
          prev.map((f) => (f.id === filmId ? { ...f, hasBeats: true, beatSource: 'wikipedia' } : f))
        )
        setMessage(`Wikipedia beats generated (${data.beatCount} beats). Refresh to see in the film page.`)
      } else {
        setBeatResults((prev) => ({ ...prev, [filmId]: 'error' }))
        setMessage(`Skipped: ${data.status.replace(/_/g, ' ')}`)
      }
    } catch (err) {
      setBeatResults((prev) => ({ ...prev, [filmId]: 'error' }))
      setMessage(err instanceof Error ? err.message : 'Wiki beat generation failed')
    } finally {
      setGeneratingBeats(null)
    }
  }

  async function generateAllWikiBeats() {
    // Snapshot candidates once — we'll track progress locally instead of
    // re-filtering from `films` state (which updates async and could cause
    // infinite loops if a film gets skipped).
    const initialCandidates = films.filter((f) => !f.hasGraph && !f.hasBeats)
    if (initialCandidates.length === 0) {
      setMessage('All films already have graphs or Wikipedia beats!')
      return
    }
    const confirmed = window.confirm(
      `Generate Wikipedia beats for ${initialCandidates.length} films? This will process them in batches and may take several minutes.`
    )
    if (!confirmed) return

    const MAX_PER_BATCH = 50
    const processedIds = new Set<string>()
    let totalGenerated = 0
    let totalSkipped = 0
    let totalFailed = 0

    setBeatsBatchRunning(true)

    try {
      let batchNum = 0
      while (true) {
        const remaining = initialCandidates.filter((f) => !processedIds.has(f.id))
        if (remaining.length === 0) break

        batchNum++
        const batchIds = remaining.slice(0, MAX_PER_BATCH).map((f) => f.id)
        setMessage(
          `Batch ${batchNum}: processing ${batchIds.length} of ${remaining.length} remaining films...`
        )

        const res = await fetch('/api/admin/films/generate-wiki-beats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filmIds: batchIds }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Batch failed')

        const generatedInBatch: string[] = []
        const skippedInBatch: string[] = []

        for (const r of data.results || []) {
          processedIds.add(r.filmId)
          if (r.status === 'generated') {
            totalGenerated++
            generatedInBatch.push(r.filmId)
          } else {
            totalSkipped++
            skippedInBatch.push(r.filmId)
          }
        }
        totalFailed += data.failed || 0

        // Batch the React state updates so we trigger one re-render per batch,
        // not per film.
        if (generatedInBatch.length > 0 || skippedInBatch.length > 0) {
          setBeatResults((prev) => {
            const next = { ...prev }
            for (const id of generatedInBatch) next[id] = 'success'
            for (const id of skippedInBatch) next[id] = 'error'
            return next
          })
        }
        if (generatedInBatch.length > 0) {
          const genSet = new Set(generatedInBatch)
          setFilms((prev) =>
            prev.map((f) =>
              genSet.has(f.id) ? { ...f, hasBeats: true, beatSource: 'wikipedia' } : f
            )
          )
        }

        // Safety: if no results came back, stop to avoid looping forever.
        if ((data.results || []).length === 0) break
      }

      setMessage(
        `Wiki beat batch complete: ${totalGenerated} generated, ${totalSkipped} skipped, ${totalFailed} failed`
      )
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Wiki beat batch failed')
    } finally {
      setBeatsBatchRunning(false)
    }
  }

  function handleMissingGraphsEvent(event: MissingGraphsEvent) {
    switch (event.type) {
      case 'start':
        setMissingGraphsProgress({ n: 0, total: event.total, title: '' })
        break
      case 'progress':
        setMissingGraphsProgress({
          n: event.n,
          total: event.total,
          title: event.title,
        })
        break
      case 'result':
        if (event.ok) {
          setResults((prev) => ({ ...prev, [event.filmId]: 'success' }))
          // Mark the film as having a graph in local state so the table
          // updates live (row flips to "Ready", button count decrements).
          setFilms((prev) =>
            prev.map((f) =>
              f.id === event.filmId
                ? { ...f, hasGraph: true, beatSource: 'graph' }
                : f
            )
          )
        } else {
          setResults((prev) => ({ ...prev, [event.filmId]: 'error' }))
        }
        break
      case 'timeout':
        // Recorded here for logging; the final summary lands in the 'done' event.
        break
      case 'done':
        setMissingGraphsSummary({
          total: event.total,
          processed: event.processed,
          succeeded: event.succeeded,
          failed: event.failed,
          timedOut: event.timedOut,
          stoppedAtTitle: event.stoppedAtTitle,
        })
        setMissingGraphsProgress(null)
        break
    }
  }

  async function generateMissingGraphs() {
    // Coarse client-side candidate count. The server re-checks with the
    // quality-review filter so the real count may be lower.
    const approxCount = films.filter(
      (f) => !f.hasGraph && f.reviewCount >= MIN_REVIEWS_FOR_MISSING_GRAPHS
    ).length
    if (approxCount === 0) {
      setMessage('No films are missing graphs (with 3+ reviews).')
      return
    }
    const confirmed = window.confirm(
      `Run sentiment pipeline on up to ${approxCount} films missing graphs? The server will stop at the 5-minute Vercel budget — just click again to resume on any films it didn't reach.`
    )
    if (!confirmed) return

    setMissingGraphsRunning(true)
    setMissingGraphsProgress(null)
    setMissingGraphsSummary(null)
    setMessage('')

    try {
      const res = await fetch('/api/admin/films/generate-missing-graphs', {
        method: 'POST',
      })

      if (!res.ok) {
        // Non-streaming error — read body as text first so a non-JSON
        // response (e.g. Vercel HTML error page) still surfaces useful
        // context, same pattern as AdminBulkImport.
        const responseText = await res.text()
        let errorMessage = `Request failed (HTTP ${res.status})`
        try {
          const data = JSON.parse(responseText)
          if (data?.error) errorMessage = data.error
        } catch {
          const snippet = responseText.slice(0, 200).trim()
          if (snippet) errorMessage += `: ${snippet}`
        }
        throw new Error(errorMessage)
      }

      if (!res.body) {
        throw new Error('No response body from server')
      }

      // ── SSE parser ──
      // Events arrive as `data: {...}\n\n`. We buffer across chunk
      // boundaries because a single TCP read can split an event.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const events = buffer.split('\n\n')
        // Last element is either empty (buffer ended on \n\n) or an
        // incomplete event — keep it in the buffer for the next read.
        buffer = events.pop() ?? ''

        for (const rawEvent of events) {
          const dataLine = rawEvent
            .split('\n')
            .find((l) => l.startsWith('data: '))
          if (!dataLine) continue
          try {
            const parsed = JSON.parse(dataLine.slice(6)) as MissingGraphsEvent
            handleMissingGraphsEvent(parsed)
          } catch {
            // malformed event — skip it, the next one will probably work
          }
        }
      }
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : 'Generate missing graphs failed'
      )
      setMissingGraphsProgress(null)
    } finally {
      setMissingGraphsRunning(false)
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
  const filmsWithoutAnyBeats = films.filter((f) => !f.hasGraph && !f.hasBeats).length
  const filmsMissingGraphsWithReviews = films.filter(
    (f) => !f.hasGraph && f.reviewCount >= MIN_REVIEWS_FOR_MISSING_GRAPHS
  ).length

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
        <div className="flex items-center gap-2">
          {filmsWithoutAnyBeats > 0 && (
            <button
              onClick={generateAllWikiBeats}
              disabled={beatsBatchRunning || missingGraphsRunning}
              className="px-4 py-2 bg-cinema-gold/10 text-cinema-gold border border-cinema-gold/30 rounded-lg text-sm hover:bg-cinema-gold/20 disabled:opacity-50 transition-colors"
              title="Generate Wikipedia story beats for films that have no NLP graph and no beats yet"
            >
              {beatsBatchRunning
                ? 'Generating beats...'
                : `Generate Wiki Beats (${filmsWithoutAnyBeats})`}
            </button>
          )}
          {filmsMissingGraphsWithReviews > 0 && (
            <button
              onClick={generateMissingGraphs}
              disabled={
                missingGraphsRunning || batchRunning || beatsBatchRunning
              }
              className="px-4 py-2 bg-cinema-teal/10 text-cinema-teal border border-cinema-teal/30 rounded-lg text-sm hover:bg-cinema-teal/20 disabled:opacity-50 transition-colors"
              title="Run the Claude sentiment pipeline on films that have no graph yet AND at least 3 reviews. Server-side quality filter may drop a few more. Resume by clicking again after the 5-minute timeout."
            >
              {missingGraphsRunning
                ? 'Generating...'
                : `Generate Missing Graphs (${filmsMissingGraphsWithReviews})`}
            </button>
          )}
          {filmsWithoutGraphs > 0 && (
            <button
              onClick={analyzeAll}
              disabled={batchRunning || missingGraphsRunning}
              className="px-4 py-2 bg-cinema-teal/20 text-cinema-teal border border-cinema-teal/30 rounded-lg text-sm hover:bg-cinema-teal/30 disabled:opacity-50 transition-colors"
            >
              {batchRunning ? 'Analyzing...' : `Generate All (${filmsWithoutGraphs})`}
            </button>
          )}
        </div>
      </div>

      {message && (
        <div className="mb-4 p-3 rounded-lg bg-cinema-card border border-cinema-border text-sm text-cinema-cream">
          {message}
        </div>
      )}

      {missingGraphsProgress && (
        <div className="mb-4 p-3 rounded-lg bg-cinema-teal/10 border border-cinema-teal/30 text-sm text-cinema-teal">
          {missingGraphsProgress.total === 0
            ? 'No eligible films found.'
            : missingGraphsProgress.n === 0
              ? `Starting... ${missingGraphsProgress.total} films to process.`
              : `Generating graph for ${missingGraphsProgress.title} (${missingGraphsProgress.n}/${missingGraphsProgress.total})`}
        </div>
      )}

      {missingGraphsSummary && (
        <div className="mb-4 p-3 rounded-lg bg-cinema-card border border-cinema-border text-sm text-cinema-cream">
          <div>
            Generated <strong>{missingGraphsSummary.succeeded}</strong> graph
            {missingGraphsSummary.succeeded === 1 ? '' : 's'}
            {missingGraphsSummary.failed > 0 &&
              `, ${missingGraphsSummary.failed} failed`}
            {' '}
            <span className="text-cinema-muted">
              ({missingGraphsSummary.processed}/{missingGraphsSummary.total} processed)
            </span>
          </div>
          {missingGraphsSummary.timedOut && missingGraphsSummary.stoppedAtTitle && (
            <div className="text-xs text-cinema-gold mt-1">
              Stopped at &ldquo;{missingGraphsSummary.stoppedAtTitle}&rdquo; — click
              &ldquo;Generate Missing Graphs&rdquo; again to resume.
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cinema-border text-left text-cinema-muted">
              <th className="py-2 pr-4">Title</th>
              <th className="py-2 pr-4">Graph</th>
              <th className="py-2 pr-4">Beats</th>
              <th className="py-2 pr-4">Reviews</th>
              <th className="py-2 pr-4">Last Analyzed</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {displayedFilms.map((film) => {
              const effectiveSource: 'graph' | 'wikipedia' | 'none' =
                film.hasGraph
                  ? 'graph'
                  : beatResults[film.id] === 'success' || film.beatSource === 'wikipedia'
                    ? 'wikipedia'
                    : 'none'
              return (
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
                  <td className="py-2 pr-4">
                    {effectiveSource === 'graph' ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-cinema-teal/10 text-cinema-teal">
                        NLP
                      </span>
                    ) : effectiveSource === 'wikipedia' ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-cinema-gold/10 text-cinema-gold">
                        Wikipedia
                      </span>
                    ) : beatResults[film.id] === 'error' ? (
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
                        disabled={
                          analyzing === film.id ||
                          batchRunning ||
                          missingGraphsRunning
                        }
                        className="text-xs px-3 py-1 bg-cinema-gold/10 text-cinema-gold border border-cinema-gold/20 rounded hover:bg-cinema-gold/20 disabled:opacity-50 transition-colors"
                      >
                        {analyzing === film.id ? 'Analyzing...' : film.hasGraph ? 'Regenerate' : 'Generate'}
                      </button>
                      {!film.hasGraph && (
                        <button
                          onClick={() => generateWikiBeats(film.id, effectiveSource === 'wikipedia')}
                          disabled={generatingBeats === film.id || beatsBatchRunning}
                          className="text-xs px-3 py-1 bg-cinema-gold/5 text-cinema-gold border border-cinema-gold/20 rounded hover:bg-cinema-gold/10 disabled:opacity-50 transition-colors"
                          title="Generate story beats from Wikipedia plot"
                        >
                          {generatingBeats === film.id
                            ? 'Generating...'
                            : effectiveSource === 'wikipedia'
                              ? 'Regen Beats'
                              : 'Wiki Beats'}
                        </button>
                      )}
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
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
