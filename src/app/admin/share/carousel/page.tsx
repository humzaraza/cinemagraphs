'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import {
  BODY_SOFT_LIMIT,
  HEADLINE_MAX,
  clampHeadline,
  headlineCounterState,
  bodyExceedsSoftLimit,
  slideCopyEqual,
} from '@/lib/carousel/body-copy-edit'
import { createDebouncer, type Debouncer } from '@/lib/carousel/debouncer'
import type { SlideCopy } from '@/lib/carousel/body-copy-generator'

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
  draftId: string
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
  bodyCopy: Record<string, SlideCopy>
  slides: DraftSlide[]
}

type SaveStatus = 'idle' | 'saving' | 'success' | 'error'

interface SlideEditState {
  headline: string
  body: string
  status: SaveStatus
  errorMessage: string | null
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

const MIDDLE_SLIDES = [2, 3, 4, 5, 6, 7] as const
const DEBOUNCE_MS = 750
const SUCCESS_FADE_MS = 1000
const HELP_DISMISSED_KEY = 'carousel-edit-help-dismissed'

function counterClass(state: 'neutral' | 'warn' | 'danger'): string {
  if (state === 'danger') return 'text-red-400'
  if (state === 'warn') return 'text-cinema-gold'
  return 'text-cinema-muted'
}

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

  // Per-slide editable state, keyed by slide number.
  const [slideEdits, setSlideEdits] = useState<Record<number, SlideEditState>>({})
  // Slide PNGs keyed by slide number for patch-in-place after save.
  const [slidePngs, setSlidePngs] = useState<Record<number, string>>({})
  // AI-original copy for the revert comparison. Comes from the persisted
  // bodyCopy on the POST response (the server mirrors aiBodyCopyJson on fresh
  // generation and backfilled it for pre-migration rows).
  const [aiBodyCopy, setAiBodyCopy] = useState<Record<string, SlideCopy>>({})
  const [helpDismissed, setHelpDismissed] = useState(true)

  const debouncersRef = useRef<Record<number, Debouncer>>({})
  const successTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  // Mirror of slideEdits for reading inside async callbacks without stale
  // closures. The debouncer's timer callback fires outside of React's render
  // cycle and needs the latest text, not the text captured at trigger time.
  const slideEditsRef = useRef<Record<number, SlideEditState>>({})

  useEffect(() => {
    if (status === 'authenticated' && session?.user?.role !== 'ADMIN') {
      router.replace('/auth/signin')
    }
  }, [status, session, router])

  useEffect(() => {
    if (typeof window === 'undefined') return
    setHelpDismissed(window.sessionStorage.getItem(HELP_DISMISSED_KEY) === '1')
  }, [])

  useEffect(() => {
    slideEditsRef.current = slideEdits
  }, [slideEdits])

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

  // Flush and clear all pending debouncers + success timers. Called on unmount
  // and before loading a new draft so a pending save doesn't write into the
  // next film/format's draft.
  const clearAllTimers = useCallback(() => {
    for (const d of Object.values(debouncersRef.current)) d.cancel()
    debouncersRef.current = {}
    for (const t of Object.values(successTimersRef.current)) clearTimeout(t)
    successTimersRef.current = {}
  }, [])

  useEffect(() => () => clearAllTimers(), [clearAllTimers])

  const loadDraft = useCallback(
    async (filmId: string, fmt: Format) => {
      clearAllTimers()
      setLoading(true)
      setError(null)
      setData(null)
      setElapsedMs(null)
      setSlideEdits({})
      setSlidePngs({})
      setAiBodyCopy({})
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

        const edits: Record<number, SlideEditState> = {}
        const pngs: Record<number, string> = {}
        for (const slide of json.slides) {
          pngs[slide.slideNumber] = slide.pngBase64
        }
        for (const n of MIDDLE_SLIDES) {
          const copy = json.bodyCopy[String(n)]
          edits[n] = {
            headline: copy?.headline ?? '',
            body: copy?.body ?? '',
            status: 'idle',
            errorMessage: null,
          }
        }
        setSlideEdits(edits)
        setSlidePngs(pngs)
        setAiBodyCopy(json.bodyCopy)
      } catch {
        setError('Failed to load draft')
      } finally {
        setLoading(false)
      }
    },
    [clearAllTimers],
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

  function dismissHelp() {
    setHelpDismissed(true)
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(HELP_DISMISSED_KEY, '1')
    }
  }

  // Actual save call. Reads the latest edit state for the slide, PATCHes, and
  // updates PNG + status on success. On failure, keeps the user's text intact
  // and flips the pip to error with the server's message.
  const saveSlide = useCallback(
    async (slideNum: number) => {
      if (!data) return
      const draftId = data.draftId
      const snapshot = slideEditsRef.current[slideNum]
      if (!snapshot) return

      if (successTimersRef.current[slideNum]) {
        clearTimeout(successTimersRef.current[slideNum])
        delete successTimersRef.current[slideNum]
      }

      setSlideEdits((prev) => {
        const entry = prev[slideNum]
        if (!entry) return prev
        return {
          ...prev,
          [slideNum]: { ...entry, status: 'saving', errorMessage: null },
        }
      })

      try {
        const res = await fetch(
          `/api/admin/carousel/draft/${draftId}/slide/${slideNum}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ headline: snapshot.headline, body: snapshot.body }),
          },
        )
        const text = await res.text()
        if (!res.ok) {
          let message = 'Save failed'
          try {
            const j = JSON.parse(text)
            if (typeof j?.error === 'string') message = j.error
          } catch { /* ignore */ }
          setSlideEdits((prev) => {
            const entry = prev[slideNum]
            if (!entry) return prev
            return {
              ...prev,
              [slideNum]: { ...entry, status: 'error', errorMessage: message },
            }
          })
          return
        }
        const json = JSON.parse(text) as {
          slideNum: number
          bodyCopy: SlideCopy
          pngBase64: string
        }
        setSlidePngs((prev) => ({ ...prev, [slideNum]: json.pngBase64 }))
        setSlideEdits((prev) => {
          const entry = prev[slideNum]
          if (!entry) return prev
          return {
            ...prev,
            [slideNum]: {
              // Re-sync with what the server persisted. This is what the
              // successful PATCH body echoed back; using it means we never
              // drift from the stored truth after a successful save.
              headline: json.bodyCopy.headline,
              body: json.bodyCopy.body,
              status: 'success',
              errorMessage: null,
            },
          }
        })
        const timer = setTimeout(() => {
          setSlideEdits((prev) => {
            const entry = prev[slideNum]
            if (!entry || entry.status !== 'success') return prev
            return { ...prev, [slideNum]: { ...entry, status: 'idle' } }
          })
          delete successTimersRef.current[slideNum]
        }, SUCCESS_FADE_MS)
        successTimersRef.current[slideNum] = timer
      } catch {
        setSlideEdits((prev) => {
          const entry = prev[slideNum]
          if (!entry) return prev
          return {
            ...prev,
            [slideNum]: { ...entry, status: 'error', errorMessage: 'Network error' },
          }
        })
      }
    },
    [data],
  )

  function getDebouncer(slideNum: number): Debouncer {
    const existing = debouncersRef.current[slideNum]
    if (existing) return existing
    const d = createDebouncer(() => { void saveSlide(slideNum) }, DEBOUNCE_MS)
    debouncersRef.current[slideNum] = d
    return d
  }

  function onHeadlineChange(slideNum: number, raw: string) {
    const clamped = clampHeadline(raw)
    setSlideEdits((prev) => {
      const entry = prev[slideNum]
      if (!entry) return prev
      return {
        ...prev,
        [slideNum]: { ...entry, headline: clamped, status: 'idle', errorMessage: null },
      }
    })
    getDebouncer(slideNum).trigger()
  }

  function onBodyChange(slideNum: number, raw: string) {
    setSlideEdits((prev) => {
      const entry = prev[slideNum]
      if (!entry) return prev
      return {
        ...prev,
        [slideNum]: { ...entry, body: raw, status: 'idle', errorMessage: null },
      }
    })
    getDebouncer(slideNum).trigger()
  }

  function onFieldBlur(slideNum: number) {
    const d = debouncersRef.current[slideNum]
    if (d && d.isPending()) d.flush()
  }

  async function onRevertClick(slideNum: number) {
    if (!data) return
    const draftId = data.draftId
    // Cancel any pending auto-save for this slide — the revert supersedes it.
    const d = debouncersRef.current[slideNum]
    if (d) d.cancel()
    if (successTimersRef.current[slideNum]) {
      clearTimeout(successTimersRef.current[slideNum])
      delete successTimersRef.current[slideNum]
    }
    setSlideEdits((prev) => {
      const entry = prev[slideNum]
      if (!entry) return prev
      return { ...prev, [slideNum]: { ...entry, status: 'saving', errorMessage: null } }
    })
    try {
      const res = await fetch(
        `/api/admin/carousel/draft/${draftId}/slide/${slideNum}/revert`,
        { method: 'POST' },
      )
      const text = await res.text()
      if (!res.ok) {
        let message = 'Revert failed'
        try {
          const j = JSON.parse(text)
          if (typeof j?.error === 'string') message = j.error
        } catch { /* ignore */ }
        setSlideEdits((prev) => {
          const entry = prev[slideNum]
          if (!entry) return prev
          return { ...prev, [slideNum]: { ...entry, status: 'error', errorMessage: message } }
        })
        return
      }
      const json = JSON.parse(text) as {
        slideNum: number
        bodyCopy: SlideCopy
        pngBase64: string
      }
      setSlidePngs((prev) => ({ ...prev, [slideNum]: json.pngBase64 }))
      setSlideEdits((prev) => ({
        ...prev,
        [slideNum]: {
          headline: json.bodyCopy.headline,
          body: json.bodyCopy.body,
          status: 'success',
          errorMessage: null,
        },
      }))
      const timer = setTimeout(() => {
        setSlideEdits((prev) => {
          const entry = prev[slideNum]
          if (!entry || entry.status !== 'success') return prev
          return { ...prev, [slideNum]: { ...entry, status: 'idle' } }
        })
        delete successTimersRef.current[slideNum]
      }, SUCCESS_FADE_MS)
      successTimersRef.current[slideNum] = timer
    } catch {
      setSlideEdits((prev) => {
        const entry = prev[slideNum]
        if (!entry) return prev
        return { ...prev, [slideNum]: { ...entry, status: 'error', errorMessage: 'Network error' } }
      })
    }
  }

  const revertDisabledMap = useMemo(() => {
    const out: Record<number, boolean> = {}
    for (const n of MIDDLE_SLIDES) {
      const edit = slideEdits[n]
      const ai = aiBodyCopy[String(n)]
      if (!edit || !ai) {
        out[n] = true
        continue
      }
      // Pill isn't editable here; compare against the AI pill so the button
      // remains disabled when text matches, even if state-drift swapped pills.
      const current: SlideCopy = {
        pill: ai.pill,
        headline: edit.headline,
        body: edit.body,
      }
      out[n] = slideCopyEqual(current, ai)
    }
    return out
  }, [slideEdits, aiBodyCopy])

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
            Edit slides 2–7 inline. Changes auto-save.
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

            {!helpDismissed && (
              <div className="bg-cinema-gold/10 border border-cinema-gold/30 rounded-lg px-3 py-2 mb-4 flex items-start gap-2">
                <span className="text-xs text-cinema-cream/80 flex-1">
                  Use{' '}
                  <code className="text-cinema-gold">{'{{color:value}}'}</code> to
                  tint inline numbers. Colors: <span className="text-red-300">red</span>,{' '}
                  <span className="text-cinema-gold">gold</span>,{' '}
                  <span className="text-cinema-teal">teal</span>.
                </span>
                <button
                  onClick={dismissHelp}
                  className="text-xs text-cinema-muted hover:text-cinema-cream shrink-0"
                  aria-label="Dismiss help"
                >
                  ×
                </button>
              </div>
            )}

            <div className="flex flex-col gap-4">
              {data.slides.map((s) => {
                const pngBase64 = slidePngs[s.slideNumber] ?? s.pngBase64
                const isMiddle =
                  s.slideNumber >= 2 && s.slideNumber <= 7
                const edit = slideEdits[s.slideNumber]
                return (
                  <div key={s.slideNumber}>
                    <div className="text-xs text-cinema-muted mb-1.5">
                      Slide {s.slideNumber} — {SLIDE_LABELS[s.slideNumber] ?? ''}
                    </div>
                    <div className="bg-[#0D0D1A] border border-[#333] rounded-lg overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`data:image/png;base64,${pngBase64}`}
                        alt={`Slide ${s.slideNumber}`}
                        width={s.widthPx}
                        height={s.heightPx}
                        className="block w-full h-auto"
                      />
                    </div>
                    {isMiddle && edit && (
                      <SlideEditor
                        slideNum={s.slideNumber}
                        edit={edit}
                        revertDisabled={revertDisabledMap[s.slideNumber] ?? true}
                        onHeadlineChange={(v) => onHeadlineChange(s.slideNumber, v)}
                        onBodyChange={(v) => onBodyChange(s.slideNumber, v)}
                        onBlur={() => onFieldBlur(s.slideNumber)}
                        onRevert={() => onRevertClick(s.slideNumber)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface SlideEditorProps {
  slideNum: number
  edit: SlideEditState
  revertDisabled: boolean
  onHeadlineChange: (v: string) => void
  onBodyChange: (v: string) => void
  onBlur: () => void
  onRevert: () => void
}

function SlideEditor({
  slideNum,
  edit,
  revertDisabled,
  onHeadlineChange,
  onBodyChange,
  onBlur,
  onRevert,
}: SlideEditorProps) {
  const headlineCounter = headlineCounterState(edit.headline.length)
  const bodyWarn = bodyExceedsSoftLimit(edit.body)

  return (
    <div className="mt-2 bg-[#1a1a2e] border border-[#333] rounded-lg p-3 flex flex-col gap-3">
      {/* Headline */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-cinema-muted">Headline</label>
          <span className={`text-[11px] ${counterClass(headlineCounter)}`}>
            {edit.headline.length}/{HEADLINE_MAX}
          </span>
        </div>
        <textarea
          value={edit.headline}
          onChange={(e) => onHeadlineChange(e.target.value)}
          onBlur={onBlur}
          rows={2}
          className="w-full bg-[#0D0D1A] border border-[#333] rounded px-2 py-1.5 text-sm text-cinema-cream focus:outline-none focus:border-cinema-gold/50 resize-none"
          placeholder="Short editorial headline..."
        />
      </div>

      {/* Body */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-cinema-muted">Body</label>
          {bodyWarn && (
            <span className="text-[11px] text-cinema-gold">
              Long body ({edit.body.length}) — may overflow
            </span>
          )}
        </div>
        <textarea
          value={edit.body}
          onChange={(e) => onBodyChange(e.target.value)}
          onBlur={onBlur}
          rows={4}
          className="w-full bg-[#0D0D1A] border border-[#333] rounded px-2 py-1.5 text-sm text-cinema-cream focus:outline-none focus:border-cinema-gold/50 resize-none"
          placeholder="Body copy..."
        />
      </div>

      {/* Footer: status pip + revert */}
      <div className="flex items-center justify-between">
        <StatusPip status={edit.status} message={edit.errorMessage} />
        <button
          onClick={onRevert}
          disabled={revertDisabled}
          className={`text-xs px-2.5 py-1 rounded border transition-colors ${
            revertDisabled
              ? 'border-[#333] text-cinema-muted/50 cursor-not-allowed'
              : 'border-cinema-gold/50 text-cinema-gold hover:bg-cinema-gold/10'
          }`}
          aria-label={`Revert slide ${slideNum} to AI version`}
        >
          Revert to AI version
        </button>
      </div>
    </div>
  )
}

function StatusPip({ status, message }: { status: SaveStatus; message: string | null }) {
  if (status === 'idle') {
    return <span className="text-[11px] text-cinema-muted/60">Auto-saves on pause</span>
  }
  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-cinema-gold">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cinema-gold animate-pulse" />
        Saving...
      </span>
    )
  }
  if (status === 'success') {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-cinema-teal">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cinema-teal" />
        Saved
      </span>
    )
  }
  return (
    <span
      title={message ?? 'Save failed'}
      className="flex items-center gap-1.5 text-[11px] text-red-300 cursor-help"
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400" />
      {message ?? 'Save failed'}
    </span>
  )
}
