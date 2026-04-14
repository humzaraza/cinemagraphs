'use client'

import { useState } from 'react'

// TMDB company IDs for common studios. Kept inline so admins don't have to
// paste numeric IDs by hand — just pick the label from the dropdown.
const COMPANY_PRESETS: Array<{ label: string; id: number }> = [
  { label: 'Pixar', id: 3 },
  { label: 'Walt Disney Animation Studios', id: 6125 },
  { label: 'Walt Disney Pictures', id: 2 },
  { label: 'A24', id: 41077 },
  { label: 'Studio Ghibli', id: 10342 },
  { label: 'Marvel Studios', id: 420 },
  { label: 'Warner Bros.', id: 174 },
  { label: 'Universal Pictures', id: 33 },
  { label: 'Paramount', id: 4 },
  { label: '20th Century', id: 25 },
  { label: 'Columbia Pictures', id: 5 },
  { label: 'New Line Cinema', id: 12 },
  { label: 'Lionsgate', id: 1632 },
  { label: 'Miramax', id: 14 },
  { label: 'Blumhouse', id: 3172 },
  { label: 'Neon', id: 90733 },
]

type BulkSource = 'tmdb_company' | 'tmdb_top_rated' | 'tmdb_popular'

interface PerFilmResult {
  tmdbId: number
  title: string
  alreadyExisted: boolean
  imdbReviewCount: number
  graph: boolean
  wikiBeats: boolean
  pending?: boolean
  error?: string
}

interface BulkImportResponse {
  source: string
  total: number
  langBreakdown: Record<string, number>
  imported: number
  alreadyExisted: number
  graphsGenerated: number
  wikiBeatsGenerated: number
  timedOut: boolean
  stoppedAtIndex: number | null
  stoppedAtTitle: string | null
  results: PerFilmResult[]
  durationMs: number
}

interface BackfillResponse {
  total: number
  processed: number
  newReviewsStored: number
  filmsGotReviews: number
  stillMissing: number
  timedOut: boolean
  stoppedAtIndex: number | null
  stoppedAtTitle: string | null
  durationMs: number
}

export default function AdminBulkImport() {
  // ── Backfill state ──
  const [backfilling, setBackfilling] = useState(false)
  const [backfillMessage, setBackfillMessage] = useState<
    { type: 'success' | 'error'; text: string } | null
  >(null)

  // ── Bulk import state ──
  const [source, setSource] = useState<BulkSource>('tmdb_company')
  const [companyId, setCompanyId] = useState<number>(COMPANY_PRESETS[0].id)
  const [maxFilms, setMaxFilms] = useState<number>(50)
  // Default ON: bulk imports are usually followed by a separate
  // "Generate Missing Graphs" pass from the Sentiment Analysis tab, so
  // we skip the Claude pipeline during import to stay well inside the
  // 300s Vercel budget. Uncheck to run the full pipeline inline.
  const [skipGraph, setSkipGraph] = useState(true)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<BulkImportResponse | null>(
    null
  )
  const [importError, setImportError] = useState<string | null>(null)

  async function handleBackfill() {
    if (
      !confirm(
        'Run IMDb review backfill? This fetches reviews for every film missing IMDb data. Takes several minutes.'
      )
    ) {
      return
    }
    setBackfilling(true)
    setBackfillMessage(null)
    try {
      const res = await fetch('/api/admin/films/backfill-reviews', {
        method: 'POST',
      })
      const data: BackfillResponse & { error?: string } = await res.json()
      if (!res.ok) throw new Error(data.error || 'Backfill failed')
      const parts = [
        `${data.total} films processed`,
        `${data.newReviewsStored} new reviews stored`,
        `${data.stillMissing} still missing`,
      ]
      if (data.timedOut && data.stoppedAtTitle) {
        parts.push(`(stopped at ${data.stoppedAtTitle} — re-run to resume)`)
      }
      setBackfillMessage({ type: 'success', text: parts.join(', ') })
    } catch (err) {
      setBackfillMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Backfill failed',
      })
    } finally {
      setBackfilling(false)
    }
  }

  function handleSourceChange(next: BulkSource) {
    setSource(next)
    setImportResult(null)
    setImportError(null)
  }

  async function handleImport() {
    const plural = maxFilms === 1 ? 'film' : 'films'
    const sourceLabel =
      source === 'tmdb_company'
        ? `company ${companyId}`
        : source === 'tmdb_top_rated'
          ? 'TMDB Top Rated'
          : 'TMDB Popular'
    const pipelineLabel = skipGraph
      ? 'review fetch + wiki beats only (no sentiment graph)'
      : 'full review + sentiment pipeline'
    if (
      !confirm(
        `Import up to ${maxFilms} ${plural} from ${sourceLabel}? This runs ${pipelineLabel} for each new film. Takes several minutes.`
      )
    ) {
      return
    }
    setImporting(true)
    setImportResult(null)
    setImportError(null)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: Record<string, any> = { source, maxFilms, skipGraph }
      if (source === 'tmdb_company') body.companyId = companyId
      const res = await fetch('/api/admin/films/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      // Read body as text first so we can surface a helpful error even when
      // the response isn't valid JSON — e.g. a Vercel 504 HTML error page
      // after a function timeout. Calling res.json() directly on HTML
      // throws an obscure WebKit error ("The string did not match the
      // expected pattern") that gives the admin no idea what happened.
      const responseText = await res.text()
      let data: BulkImportResponse | { error?: string } | null = null
      let parseError: unknown = null
      try {
        data = JSON.parse(responseText)
      } catch (e) {
        parseError = e
      }

      if (!res.ok) {
        const backendError =
          data && typeof data === 'object' && 'error' in data
            ? data.error
            : null
        const snippet = responseText.slice(0, 200).trim()
        throw new Error(
          backendError ||
            `Bulk import failed (HTTP ${res.status})${snippet ? `: ${snippet}` : ''}`
        )
      }

      if (parseError || !data) {
        const snippet = responseText.slice(0, 200).trim()
        throw new Error(
          `Bulk import returned an invalid JSON response${snippet ? `: ${snippet}` : ''}`
        )
      }

      setImportResult(data as BulkImportResponse)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Bulk import failed')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-10">
      {/* ── Backfill IMDb Reviews ── */}
      <section>
        <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-2">
          Backfill IMDb Reviews
        </h2>
        <p className="text-sm text-cinema-muted mb-4">
          Re-runs the IMDb fetcher for every film with an imdbId but zero
          stored IMDb reviews. Safe to run repeatedly — uses only the IMDb
          source, no Claude budget.
        </p>
        <button
          onClick={handleBackfill}
          disabled={backfilling}
          className="bg-cinema-gold text-cinema-dark font-semibold px-6 py-2 rounded-lg hover:bg-cinema-gold/90 transition-colors disabled:opacity-50"
        >
          {backfilling ? 'Backfilling...' : 'Backfill IMDb Reviews'}
        </button>
        {backfillMessage && (
          <div
            className={`mt-4 px-4 py-2 rounded-lg text-sm ${
              backfillMessage.type === 'success'
                ? 'bg-cinema-teal/10 text-cinema-teal border border-cinema-teal/30'
                : 'bg-red-500/10 text-red-400 border border-red-500/30'
            }`}
          >
            {backfillMessage.text}
          </div>
        )}
      </section>

      {/* ── Bulk Film Import ── */}
      <section>
        <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-2">
          Bulk Film Import
        </h2>
        <p className="text-sm text-cinema-muted mb-4">
          Imports films from a TMDB list, fetches reviews from every source,
          and (unless &ldquo;Import only&rdquo; is checked) runs the full sentiment
          pipeline — or falls back to Wikipedia beats — for each new film.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          {/* Source dropdown */}
          <div>
            <label className="block text-xs text-cinema-muted mb-1">
              Source
            </label>
            <select
              value={source}
              onChange={(e) => handleSourceChange(e.target.value as BulkSource)}
              disabled={importing}
              className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2 text-cinema-cream focus:outline-none focus:border-cinema-gold/50 disabled:opacity-50"
            >
              <option value="tmdb_company">TMDB — Production Company</option>
              <option value="tmdb_top_rated">TMDB — Top Rated</option>
              <option value="tmdb_popular">TMDB — Popular</option>
            </select>
          </div>

          {/* Company dropdown — only shown for tmdb_company */}
          {source === 'tmdb_company' && (
            <div>
              <label className="block text-xs text-cinema-muted mb-1">
                Company
              </label>
              <select
                value={companyId}
                onChange={(e) => setCompanyId(Number(e.target.value))}
                disabled={importing}
                className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2 text-cinema-cream focus:outline-none focus:border-cinema-gold/50 disabled:opacity-50"
              >
                {COMPANY_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Max films input */}
          <div>
            <label className="block text-xs text-cinema-muted mb-1">
              Max films
            </label>
            <input
              type="number"
              min={1}
              max={500}
              value={maxFilms}
              onChange={(e) => setMaxFilms(Number(e.target.value) || 0)}
              disabled={importing}
              className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2 text-cinema-cream focus:outline-none focus:border-cinema-gold/50 disabled:opacity-50"
            />
          </div>
        </div>

        {/* Import only toggle */}
        <label className="flex items-start gap-2 mb-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={skipGraph}
            onChange={(e) => setSkipGraph(e.target.checked)}
            disabled={importing}
            className="mt-0.5 accent-cinema-teal disabled:opacity-50"
          />
          <span className="text-sm text-cinema-cream">
            Import only (skip graph generation)
            <span className="block text-xs text-cinema-muted mt-0.5">
              Fetches reviews and generates Wikipedia beats as fallback, but
              does not run the Claude sentiment pipeline. Use &ldquo;Generate
              Missing Graphs&rdquo; on the Sentiment Analysis tab afterwards.
            </span>
          </span>
        </label>

        <button
          onClick={handleImport}
          disabled={importing || maxFilms <= 0}
          className="bg-cinema-teal text-cinema-dark font-semibold px-6 py-2 rounded-lg hover:bg-cinema-teal/90 transition-colors disabled:opacity-50"
        >
          {importing ? 'Importing...' : 'Import'}
        </button>

        {importError && (
          <div className="mt-4 px-4 py-2 rounded-lg text-sm bg-red-500/10 text-red-400 border border-red-500/30">
            {importError}
          </div>
        )}

        {importResult && (
          <div className="mt-6 space-y-4">
            <div className="bg-cinema-teal/10 text-cinema-teal border border-cinema-teal/30 rounded-lg px-4 py-3 text-sm">
              <div className="font-semibold">
                {importResult.imported} imported, {importResult.alreadyExisted}{' '}
                already existed, {importResult.graphsGenerated} graphs generated,{' '}
                {importResult.wikiBeatsGenerated} wiki beats generated
              </div>
              <div className="text-xs text-cinema-teal/70 mt-1">
                {importResult.total} total candidates,{' '}
                {(importResult.durationMs / 1000).toFixed(1)}s
                {importResult.timedOut &&
                  importResult.stoppedAtTitle &&
                  ` · stopped at ${importResult.stoppedAtTitle} — re-run to resume`}
              </div>
              {importResult.langBreakdown &&
                Object.keys(importResult.langBreakdown).length > 0 && (
                  <div className="text-xs text-cinema-teal/70 mt-1">
                    languages:{' '}
                    {Object.entries(importResult.langBreakdown)
                      .sort((a, b) => b[1] - a[1])
                      .map(([lang, count]) => `${lang}:${count}`)
                      .join(', ')}
                  </div>
                )}
            </div>

            {importResult.results.length > 0 && (
              <div className="bg-cinema-card border border-cinema-border rounded-lg overflow-hidden">
                <div className="max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-cinema-darker text-xs uppercase text-cinema-muted sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2">Film</th>
                        <th className="text-right px-3 py-2">IMDb</th>
                        <th className="text-center px-3 py-2">Graph</th>
                        <th className="text-center px-3 py-2">Wiki</th>
                        <th className="text-left px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importResult.results.map((r, idx) => (
                        <tr
                          key={`${r.tmdbId}-${idx}`}
                          className="border-t border-cinema-border/50"
                        >
                          <td className="px-3 py-2 text-cinema-cream truncate max-w-[240px]">
                            {r.title}
                          </td>
                          <td className="px-3 py-2 text-right text-cinema-muted">
                            {r.imdbReviewCount}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {r.graph ? (
                              <span className="text-cinema-teal">yes</span>
                            ) : (
                              <span className="text-cinema-muted">no</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {r.wikiBeats ? (
                              <span className="text-cinema-gold">yes</span>
                            ) : (
                              <span className="text-cinema-muted">no</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {r.error ? (
                              <span className="text-red-400">
                                error: {r.error}
                              </span>
                            ) : r.pending ? (
                              <span className="text-cinema-gold">
                                pending (re-run to process)
                              </span>
                            ) : r.alreadyExisted ? (
                              <span className="text-cinema-muted">
                                already existed
                              </span>
                            ) : (
                              <span className="text-cinema-teal">imported</span>
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
        )}
      </section>
    </div>
  )
}
