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
import { conflictsForSlot } from '@/lib/carousel/slot-conflicts'
import { buildCarouselZip } from '@/lib/carousel/zip-export-builder'
import { buildZipFilename } from '@/lib/carousel/zip-export-naming'
import {
  BeatPickerDropdown,
  type AvailableBeat,
} from '@/components/admin/carousel/BeatPickerDropdown'
import { StillsPicker } from '@/components/admin/carousel/StillsPicker'

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

interface SlotSelection {
  position: number
  kind: string
  originalRole: string | null
  beatTimestamp: number | null
  beatScore: number | null
  timestampLabel: string
  collision: boolean
  duplicateTimestamp: boolean
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
  aiBodyCopy: Record<string, SlideCopy>
  slotSelections: SlotSelection[]
  aiSlotSelections: SlotSelection[]
  availableBeats: AvailableBeat[]
  slideBackdrops: Record<string, string> | null
  slides: DraftSlide[]
}

type SaveStatus = 'idle' | 'saving' | 'success' | 'error'

interface SlideEditState {
  headline: string
  body: string
  status: SaveStatus
  errorMessage: string | null
}

interface BeatEditState {
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

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

type ZipDownloadStatus = 'idle' | 'saving' | 'error'

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
  // Per-slot beat selections — current persisted state.
  const [slotSelections, setSlotSelections] = useState<SlotSelection[]>([])
  // Algorithm baseline for the Reset-to-AI button.
  const [aiSlotSelections, setAiSlotSelections] = useState<SlotSelection[]>([])
  // Available beats for the dropdown — stable per draft load.
  const [availableBeats, setAvailableBeats] = useState<AvailableBeat[]>([])
  // Per-slot save status for beat changes (separate from text-edit pip).
  const [beatEdits, setBeatEdits] = useState<Record<number, BeatEditState>>({})
  // Per-slot save status for regenerate (separate pip from beat + text edit).
  const [regenerateEdits, setRegenerateEdits] = useState<Record<number, BeatEditState>>({})
  // Stills picker: which slide's drawer is open, per-slot save status, and the
  // currently-applied custom still URL per slide (null / missing = using default).
  const [stillsPickerOpenFor, setStillsPickerOpenFor] = useState<number | null>(null)
  const [slideStillEdits, setSlideStillEdits] = useState<Record<number, BeatEditState>>({})
  const [slideStills, setSlideStills] = useState<Record<number, string | null>>({})
  const [helpDismissed, setHelpDismissed] = useState(true)

  // ZIP-export state. zipFormat tracks `data.format` on draft load but can be
  // overridden by the admin; the footer's dropdown drives what the ZIP pulls
  // from independently of the preview above.
  const [zipFormat, setZipFormat] = useState<Format>(format)
  const [zipDownloadStatus, setZipDownloadStatus] = useState<ZipDownloadStatus>('idle')
  const [zipErrorMessage, setZipErrorMessage] = useState<string | null>(null)

  const debouncersRef = useRef<Record<number, Debouncer>>({})
  const successTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  // Separate fade-out timers for the beat-pip; same SUCCESS_FADE_MS as text.
  const beatSuccessTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  // Fade-out timers for the regenerate pip (distinct from beat and text timers).
  const regenerateSuccessTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO(lint): SSR-safe hydration pattern; lazy-init would mismatch server render. Revisit when migrating to useSyncExternalStore.
    setHelpDismissed(window.sessionStorage.getItem(HELP_DISMISSED_KEY) === '1')
  }, [])

  useEffect(() => {
    slideEditsRef.current = slideEdits
  }, [slideEdits])

  // Cycle loading messages every 3s while loading.
  useEffect(() => {
    if (!loading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO(lint): sync-external-state pattern; revisit when migrating to derived state
      setLoadingMsgIdx(0)
      return
    }
    const id = setInterval(() => {
      setLoadingMsgIdx((i) => (i + 1) % LOADING_MESSAGES.length)
    }, 3000)
    return () => clearInterval(id)
  }, [loading])

  // When a new draft lands, reset the ZIP dropdown to match the loaded format
  // and clear any lingering error pip from a prior attempt.
  useEffect(() => {
    if (data?.format) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO(lint): sync-external-state pattern; revisit when migrating to derived state
      setZipFormat(data.format)
      setZipDownloadStatus('idle')
      setZipErrorMessage(null)
    }
  }, [data?.format, data?.draftId])

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
    for (const t of Object.values(beatSuccessTimersRef.current)) clearTimeout(t)
    beatSuccessTimersRef.current = {}
    for (const t of Object.values(regenerateSuccessTimersRef.current)) clearTimeout(t)
    regenerateSuccessTimersRef.current = {}
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
      setSlotSelections([])
      setAiSlotSelections([])
      setAvailableBeats([])
      setBeatEdits({})
      setRegenerateEdits({})
      setStillsPickerOpenFor(null)
      setSlideStillEdits({})
      setSlideStills({})
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
        setAiBodyCopy(json.aiBodyCopy ?? json.bodyCopy)
        setSlotSelections(json.slotSelections ?? [])
        setAiSlotSelections(json.aiSlotSelections ?? [])
        setAvailableBeats(json.availableBeats ?? [])
        const beatInit: Record<number, BeatEditState> = {}
        const regenInit: Record<number, BeatEditState> = {}
        for (const n of MIDDLE_SLIDES) {
          beatInit[n] = { status: 'idle', errorMessage: null }
          regenInit[n] = { status: 'idle', errorMessage: null }
        }
        setBeatEdits(beatInit)
        setRegenerateEdits(regenInit)
        const stillsSeed: Record<number, string | null> = {}
        if (json.slideBackdrops) {
          for (const [k, v] of Object.entries(json.slideBackdrops)) {
            stillsSeed[Number(k)] = v
          }
        }
        setSlideStills(stillsSeed)
        setSlideStillEdits({})
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

  // Resolve the beatIndex (position in the sorted availableBeats array) for
  // the slot's currently-persisted beatTimestamp. Both server fields are
  // produced from the same sorted beats array via formatTimestamp(), so
  // matching by the timestampLabel string is exact.
  const beatIndexForSlot = useCallback(
    (slotPos: number): number | null => {
      const slot = slotSelections.find((s) => s.position === slotPos)
      if (!slot || slot.beatTimestamp === null) return null
      const beat = availableBeats.find(
        (b) => b.timestamp === (slot.timestampLabel ?? '').trim(),
      )
      return beat ? beat.beatIndex : null
    },
    [availableBeats, slotSelections],
  )

  // Build per-slot conflict map (positions of OTHER middle slots sharing the
  // same beatTimestamp). Used to render the "Same beat as Slide N" warning.
  const conflictMap = useMemo(() => {
    const out: Record<number, number[]> = {}
    for (const n of MIDDLE_SLIDES) {
      out[n] = conflictsForSlot(slotSelections, n)
    }
    return out
  }, [slotSelections])

  // Reset is disabled when the slot's current beatTimestamp already matches
  // the AI baseline (idempotent state).
  const beatResetDisabledMap = useMemo(() => {
    const out: Record<number, boolean> = {}
    for (const n of MIDDLE_SLIDES) {
      const cur = slotSelections.find((s) => s.position === n)
      const ai = aiSlotSelections.find((s) => s.position === n)
      out[n] = !cur || !ai || cur.beatTimestamp === ai.beatTimestamp
    }
    return out
  }, [slotSelections, aiSlotSelections])

  // Dropdown change handler: PATCH the beat, replace the slot's PNG, update
  // local slotSelections (collision flags too) from the server response.
  // Pip indicator follows the same gold→teal→fade cycle as the text saves.
  const onBeatChange = useCallback(
    async (slideNum: number, beatIndex: number) => {
      if (!data) return
      const draftId = data.draftId
      // Cancel any pending text-save for this slot — they share the same
      // pip slot but are different requests; finishing them in either order
      // is fine, but if the user is rapidly clicking dropdown they expect
      // immediate saving status.
      if (beatSuccessTimersRef.current[slideNum]) {
        clearTimeout(beatSuccessTimersRef.current[slideNum])
        delete beatSuccessTimersRef.current[slideNum]
      }
      setBeatEdits((prev) => ({
        ...prev,
        [slideNum]: { status: 'saving', errorMessage: null },
      }))
      try {
        const res = await fetch(
          `/api/admin/carousel/draft/${draftId}/slide/${slideNum}/beat`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ beatIndex }),
          },
        )
        const text = await res.text()
        if (!res.ok) {
          let message = 'Beat change failed'
          try {
            const j = JSON.parse(text)
            if (typeof j?.error === 'string') message = j.error
          } catch { /* ignore */ }
          setBeatEdits((prev) => ({
            ...prev,
            [slideNum]: { status: 'error', errorMessage: message },
          }))
          return
        }
        const json = JSON.parse(text) as {
          slideNum: number
          slotSelection: SlotSelection
          pngBase64: string | null
          conflicts: number[]
          noop: boolean
        }
        if (json.pngBase64) {
          setSlidePngs((prev) => ({ ...prev, [slideNum]: json.pngBase64! }))
        }
        // Replace the slot AND recompute collision flags for ALL middle slots
        // from the new state. The endpoint already persisted these flags;
        // mirror them locally so the UI updates without a refetch.
        setSlotSelections((prev) => {
          const next = prev.map((s) =>
            s.position === slideNum ? json.slotSelection : s,
          )
          // Conflict flags: the response.conflicts list is OTHER positions
          // sharing the new beat. Mark them collision: true; everything else
          // collision: false (excluding hook/takeaway).
          const conflictSet = new Set([slideNum, ...json.conflicts])
          return next.map((s) => {
            if (s.position < 2 || s.position > 7) return s
            const newCollision = json.conflicts.length > 0 && conflictSet.has(s.position)
            return { ...s, collision: newCollision }
          })
        })
        setBeatEdits((prev) => ({
          ...prev,
          [slideNum]: { status: 'success', errorMessage: null },
        }))
        const timer = setTimeout(() => {
          setBeatEdits((prev) => {
            const entry = prev[slideNum]
            if (!entry || entry.status !== 'success') return prev
            return { ...prev, [slideNum]: { ...entry, status: 'idle' } }
          })
          delete beatSuccessTimersRef.current[slideNum]
        }, SUCCESS_FADE_MS)
        beatSuccessTimersRef.current[slideNum] = timer
      } catch {
        setBeatEdits((prev) => ({
          ...prev,
          [slideNum]: { status: 'error', errorMessage: 'Network error' },
        }))
      }
    },
    [data],
  )

  const onBeatReset = useCallback(
    async (slideNum: number) => {
      if (!data) return
      const draftId = data.draftId
      if (beatSuccessTimersRef.current[slideNum]) {
        clearTimeout(beatSuccessTimersRef.current[slideNum])
        delete beatSuccessTimersRef.current[slideNum]
      }
      setBeatEdits((prev) => ({
        ...prev,
        [slideNum]: { status: 'saving', errorMessage: null },
      }))
      try {
        const res = await fetch(
          `/api/admin/carousel/draft/${draftId}/slide/${slideNum}/beat/reset`,
          { method: 'POST' },
        )
        const text = await res.text()
        if (!res.ok) {
          let message = 'Reset failed'
          try {
            const j = JSON.parse(text)
            if (typeof j?.error === 'string') message = j.error
          } catch { /* ignore */ }
          setBeatEdits((prev) => ({
            ...prev,
            [slideNum]: { status: 'error', errorMessage: message },
          }))
          return
        }
        const json = JSON.parse(text) as {
          slideNum: number
          slotSelection: SlotSelection
          pngBase64: string
          conflicts: number[]
        }
        setSlidePngs((prev) => ({ ...prev, [slideNum]: json.pngBase64 }))
        setSlotSelections((prev) => {
          const next = prev.map((s) =>
            s.position === slideNum ? json.slotSelection : s,
          )
          const conflictSet = new Set([slideNum, ...json.conflicts])
          return next.map((s) => {
            if (s.position < 2 || s.position > 7) return s
            const newCollision = json.conflicts.length > 0 && conflictSet.has(s.position)
            return { ...s, collision: newCollision }
          })
        })
        setBeatEdits((prev) => ({
          ...prev,
          [slideNum]: { status: 'success', errorMessage: null },
        }))
        const timer = setTimeout(() => {
          setBeatEdits((prev) => {
            const entry = prev[slideNum]
            if (!entry || entry.status !== 'success') return prev
            return { ...prev, [slideNum]: { ...entry, status: 'idle' } }
          })
          delete beatSuccessTimersRef.current[slideNum]
        }, SUCCESS_FADE_MS)
        beatSuccessTimersRef.current[slideNum] = timer
      } catch {
        setBeatEdits((prev) => ({
          ...prev,
          [slideNum]: { status: 'error', errorMessage: 'Network error' },
        }))
      }
    },
    [data],
  )

  // Regenerate pulls fresh AI body copy for one slide's CURRENT beat. Uses the
  // render-then-persist pattern — the server renders with the candidate copy
  // and only commits bodyCopyJson on success. aiBodyCopyJson is never touched,
  // so Revert continues to point at the original AI baseline.
  //
  // Cancels the text-edit debouncer for this slide — the regenerated copy
  // supersedes any pending edit. Mirrors the response pill into slideEdits
  // (via full slide-copy replacement); the pill lives server-side only so it
  // doesn't need its own state.
  const onRegenerateClick = useCallback(
    async (slideNum: number) => {
      if (!data) return
      const draftId = data.draftId
      const d = debouncersRef.current[slideNum]
      if (d) d.cancel()
      if (successTimersRef.current[slideNum]) {
        clearTimeout(successTimersRef.current[slideNum])
        delete successTimersRef.current[slideNum]
      }
      if (regenerateSuccessTimersRef.current[slideNum]) {
        clearTimeout(regenerateSuccessTimersRef.current[slideNum])
        delete regenerateSuccessTimersRef.current[slideNum]
      }
      setRegenerateEdits((prev) => ({
        ...prev,
        [slideNum]: { status: 'saving', errorMessage: null },
      }))
      try {
        const res = await fetch(
          `/api/admin/carousel/draft/${draftId}/slide/${slideNum}/regenerate`,
          { method: 'POST' },
        )
        const text = await res.text()
        if (!res.ok) {
          let message = 'Regenerate failed'
          try {
            const j = JSON.parse(text)
            if (typeof j?.error === 'string') message = j.error
          } catch { /* ignore */ }
          setRegenerateEdits((prev) => ({
            ...prev,
            [slideNum]: { status: 'error', errorMessage: message },
          }))
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
            status: 'idle',
            errorMessage: null,
          },
        }))
        setRegenerateEdits((prev) => ({
          ...prev,
          [slideNum]: { status: 'success', errorMessage: null },
        }))
        const timer = setTimeout(() => {
          setRegenerateEdits((prev) => {
            const entry = prev[slideNum]
            if (!entry || entry.status !== 'success') return prev
            return { ...prev, [slideNum]: { ...entry, status: 'idle' } }
          })
          delete regenerateSuccessTimersRef.current[slideNum]
        }, SUCCESS_FADE_MS)
        regenerateSuccessTimersRef.current[slideNum] = timer
      } catch {
        setRegenerateEdits((prev) => ({
          ...prev,
          [slideNum]: { status: 'error', errorMessage: 'Network error' },
        }))
      }
    },
    [data],
  )

  // Bundle the 8 slide PNGs into a ZIP and trigger a browser download. When
  // zipFormat matches the currently-loaded data.format, we prefer per-slide
  // edit-patched PNGs from slidePngs so post-edit state exports correctly.
  // When it doesn't match, we fetch the other format's draft inline WITHOUT
  // touching preview state — any edits in progress on the loaded format stay
  // intact.
  const onDownloadZip = useCallback(async () => {
    if (!data) return
    setZipDownloadStatus('saving')
    setZipErrorMessage(null)
    try {
      let exportSlides: Array<{ slideNumber: number; pngBase64: string }>
      let exportSlots: Array<{ position: number; kind: string }>
      if (zipFormat === data.format) {
        exportSlides = data.slides.map((s) => ({
          slideNumber: s.slideNumber,
          pngBase64: slidePngs[s.slideNumber] ?? s.pngBase64,
        }))
        exportSlots = slotSelections.map((s) => ({ position: s.position, kind: s.kind }))
      } else {
        const res = await fetch('/api/admin/carousel/draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filmId: data.film.id, format: zipFormat }),
        })
        const text = await res.text()
        if (!res.ok) {
          let message = 'Failed to load draft for download'
          try {
            const j = JSON.parse(text)
            if (typeof j?.error === 'string') message = j.error
          } catch { /* ignore */ }
          throw new Error(message)
        }
        const json = JSON.parse(text) as DraftResponse
        exportSlides = json.slides.map((s) => ({
          slideNumber: s.slideNumber,
          pngBase64: s.pngBase64,
        }))
        exportSlots = (json.slotSelections ?? []).map((s) => ({
          position: s.position,
          kind: s.kind,
        }))
      }
      const blob = await buildCarouselZip({
        slides: exportSlides,
        slotSelections: exportSlots,
        filmTitle: data.film.title,
        format: zipFormat,
      })
      const filename = buildZipFilename({
        filmTitle: data.film.title,
        format: zipFormat,
      })
      triggerBlobDownload(blob, filename)
      setZipDownloadStatus('idle')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Download failed'
      setZipDownloadStatus('error')
      setZipErrorMessage(message)
    }
  }, [data, zipFormat, slidePngs, slotSelections])

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
            className="w-full bg-cinema-card border border-[#333] rounded-lg px-3 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/50"
          />
          {results.length > 0 && (
            <div className="absolute z-20 top-full mt-1 w-full bg-cinema-card border border-[#333] rounded-lg max-h-64 overflow-y-auto shadow-xl">
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
          <div className="bg-cinema-card border border-[#333] rounded-lg px-4 py-8 text-center">
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
            <div className="bg-cinema-card border border-[#333] rounded-lg px-4 py-3 mb-4">
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
                    <div className="relative bg-cinema-dark border border-[#333] rounded-lg overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`data:image/png;base64,${pngBase64}`}
                        alt={`Slide ${s.slideNumber}`}
                        width={s.widthPx}
                        height={s.heightPx}
                        className="block w-full h-auto"
                      />
                      <button
                        type="button"
                        onClick={() => setStillsPickerOpenFor(s.slideNumber)}
                        aria-label={`Pick still for slide ${s.slideNumber}`}
                        className="absolute top-2 right-2 bg-black/70 backdrop-blur-sm border border-cinema-gold/50 text-cinema-gold rounded-full px-3 py-1 text-xs hover:bg-black/80"
                      >
                        {slideStills[s.slideNumber] ? 'Change still' : 'Pick still'}
                      </button>
                    </div>
                    {isMiddle && (
                      <BeatPickerSection
                        slideNum={s.slideNumber}
                        slotLabel={SLIDE_LABELS[s.slideNumber] ?? ''}
                        beats={availableBeats}
                        selectedBeatIndex={beatIndexForSlot(s.slideNumber)}
                        beatEdit={beatEdits[s.slideNumber] ?? { status: 'idle', errorMessage: null }}
                        resetDisabled={beatResetDisabledMap[s.slideNumber] ?? true}
                        conflictPositions={conflictMap[s.slideNumber] ?? []}
                        onChange={(idx) => onBeatChange(s.slideNumber, idx)}
                        onReset={() => onBeatReset(s.slideNumber)}
                      />
                    )}
                    {isMiddle && edit && (
                      <SlideEditor
                        slideNum={s.slideNumber}
                        edit={edit}
                        revertDisabled={revertDisabledMap[s.slideNumber] ?? true}
                        regenerateState={regenerateEdits[s.slideNumber] ?? { status: 'idle', errorMessage: null }}
                        onHeadlineChange={(v) => onHeadlineChange(s.slideNumber, v)}
                        onBodyChange={(v) => onBodyChange(s.slideNumber, v)}
                        onBlur={() => onFieldBlur(s.slideNumber)}
                        onRevert={() => onRevertClick(s.slideNumber)}
                        onRegenerate={() => onRegenerateClick(s.slideNumber)}
                      />
                    )}
                  </div>
                )
              })}
            </div>

            {/* ZIP export footer */}
            <div className="mt-8 flex flex-col items-center gap-1.5">
              <div className="flex items-center gap-2">
                <select
                  aria-label="Export format"
                  value={zipFormat}
                  onChange={(e) => {
                    setZipFormat(e.target.value as Format)
                    if (zipDownloadStatus === 'error') {
                      setZipDownloadStatus('idle')
                      setZipErrorMessage(null)
                    }
                  }}
                  disabled={zipDownloadStatus === 'saving'}
                  className="text-xs bg-cinema-card border border-[#333] rounded-lg px-2.5 py-1.5 text-cinema-cream focus:outline-none focus:border-cinema-gold/50 disabled:opacity-50"
                >
                  <option value="4x5">4:5 (Instagram)</option>
                  <option value="9x16">9:16 (TikTok)</option>
                </select>
                <button
                  onClick={onDownloadZip}
                  disabled={zipDownloadStatus === 'saving'}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                    zipDownloadStatus === 'saving'
                      ? 'border-[#333] text-cinema-muted/50 cursor-not-allowed'
                      : 'border-cinema-gold/50 text-cinema-gold hover:bg-cinema-gold/10'
                  }`}
                  aria-label="Download all 8 slides as a ZIP file"
                >
                  {zipDownloadStatus === 'saving' ? 'Preparing...' : 'Download ZIP'}
                </button>
                {zipDownloadStatus === 'saving' && (
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full bg-cinema-gold animate-pulse"
                    aria-hidden
                  />
                )}
                {zipDownloadStatus === 'error' && (
                  <span
                    title={zipErrorMessage ?? 'Download failed'}
                    className="flex items-center gap-1.5 text-[11px] text-red-300 cursor-help"
                  >
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400" />
                    {zipErrorMessage ?? 'Download failed'}
                  </span>
                )}
              </div>
              <span className="text-[11px] text-cinema-muted">
                Downloads 8 PNGs as a ZIP file ready for Instagram or TikTok upload.
              </span>
            </div>

            {stillsPickerOpenFor !== null && data && (
              <StillsPicker
                isOpen={stillsPickerOpenFor !== null}
                filmId={data.film.id}
                filmTitle={data.film.title}
                slideNumber={stillsPickerOpenFor}
                slideLabel={SLIDE_LABELS[stillsPickerOpenFor] ?? ''}
                currentStillUrl={slideStills[stillsPickerOpenFor] ?? null}
                onClose={() => setStillsPickerOpenFor(null)}
                onApply={async (stillUrl) => {
                  const slideNum = stillsPickerOpenFor
                  setSlideStillEdits((prev) => ({
                    ...prev,
                    [slideNum]: { status: 'saving', errorMessage: null },
                  }))
                  try {
                    const res = await fetch(
                      `/api/admin/carousel/draft/${data.draftId}/slide/${slideNum}/still`,
                      {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ stillUrl }),
                      },
                    )
                    if (!res.ok) {
                      const err = await res
                        .json()
                        .catch(() => ({ error: 'Request failed' }))
                      throw new Error(err.error || 'Request failed')
                    }
                    const body = (await res.json()) as {
                      slideNum: number
                      stillUrl: string | null
                      pngBase64: string
                    }
                    setSlidePngs((prev) => ({
                      ...prev,
                      [slideNum]: body.pngBase64,
                    }))
                    setSlideStills((prev) => ({
                      ...prev,
                      [slideNum]: stillUrl,
                    }))
                    setSlideStillEdits((prev) => ({
                      ...prev,
                      [slideNum]: { status: 'success', errorMessage: null },
                    }))
                    setStillsPickerOpenFor(null)
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    setSlideStillEdits((prev) => ({
                      ...prev,
                      [slideNum]: { status: 'error', errorMessage: msg },
                    }))
                  }
                }}
              />
            )}
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
  regenerateState: BeatEditState
  onHeadlineChange: (v: string) => void
  onBodyChange: (v: string) => void
  onBlur: () => void
  onRevert: () => void
  onRegenerate: () => void
}

function SlideEditor({
  slideNum,
  edit,
  revertDisabled,
  regenerateState,
  onHeadlineChange,
  onBodyChange,
  onBlur,
  onRevert,
  onRegenerate,
}: SlideEditorProps) {
  const headlineCounter = headlineCounterState(edit.headline.length)
  const bodyWarn = bodyExceedsSoftLimit(edit.body)
  const regenerating = regenerateState.status === 'saving'

  return (
    <div className="mt-2 bg-cinema-card border border-[#333] rounded-lg p-3 flex flex-col gap-3">
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
          className="w-full bg-cinema-dark border border-[#333] rounded px-2 py-1.5 text-sm text-cinema-cream focus:outline-none focus:border-cinema-gold/50 resize-none"
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
          className="w-full bg-cinema-dark border border-[#333] rounded px-2 py-1.5 text-sm text-cinema-cream focus:outline-none focus:border-cinema-gold/50 resize-none"
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

      {/* Regenerate row: separate from revert, intentionally never disabled */}
      <div className="flex items-center justify-between pt-2 border-t border-[#2a2a3a]">
        <div className="flex flex-col gap-0.5">
          <BeatStatusPip status={regenerateState.status} message={regenerateState.errorMessage} />
          <span className="text-[11px] text-cinema-muted/70">
            Regenerate writes new AI body copy for the current beat. Use after changing the beat above.
          </span>
        </div>
        <button
          onClick={onRegenerate}
          disabled={regenerating}
          className={`text-xs px-2.5 py-1 rounded border transition-colors ${
            regenerating
              ? 'border-[#333] text-cinema-muted/50 cursor-not-allowed'
              : 'border-cinema-gold/50 text-cinema-gold hover:bg-cinema-gold/10'
          }`}
          aria-label={`Regenerate slide ${slideNum} body copy`}
        >
          {regenerating ? 'Regenerating...' : 'Regenerate copy'}
        </button>
      </div>
    </div>
  )
}

interface BeatPickerSectionProps {
  slideNum: number
  slotLabel: string
  beats: AvailableBeat[]
  selectedBeatIndex: number | null
  beatEdit: BeatEditState
  resetDisabled: boolean
  conflictPositions: number[]
  onChange: (beatIndex: number) => void
  onReset: () => void
}

function BeatPickerSection({
  slideNum,
  slotLabel,
  beats,
  selectedBeatIndex,
  beatEdit,
  resetDisabled,
  conflictPositions,
  onChange,
  onReset,
}: BeatPickerSectionProps) {
  const saving = beatEdit.status === 'saving'
  const conflictText =
    conflictPositions.length === 0
      ? null
      : conflictPositions.length === 1
        ? `Same beat as Slide ${conflictPositions[0]}`
        : `Same beat as Slides ${conflictPositions.join(', ')}`

  return (
    <div className="mt-2 bg-cinema-card border border-[#333] rounded-lg p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs text-cinema-muted">Beat</label>
        {conflictText && (
          <span
            className="text-[11px] text-cinema-gold flex items-center gap-1.5"
            title="Two slides currently point at the same beat — pick a different one to keep the carousel varied."
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-cinema-gold" />
            {conflictText}
          </span>
        )}
      </div>
      <BeatPickerDropdown
        beats={beats}
        selectedBeatIndex={selectedBeatIndex}
        slotLabel={slotLabel}
        onChange={onChange}
        disabled={saving}
      />
      <div className="flex items-center justify-between">
        <BeatStatusPip status={beatEdit.status} message={beatEdit.errorMessage} />
        <button
          onClick={onReset}
          disabled={resetDisabled || saving}
          className={`text-xs px-2.5 py-1 rounded border transition-colors ${
            resetDisabled || saving
              ? 'border-[#333] text-cinema-muted/50 cursor-not-allowed'
              : 'border-cinema-gold/50 text-cinema-gold hover:bg-cinema-gold/10'
          }`}
          aria-label={`Reset slide ${slideNum} beat to algorithm's pick`}
        >
          Reset to algorithm&apos;s pick
        </button>
      </div>
    </div>
  )
}

// Variant of StatusPip with no idle text — the beat row doesn't auto-save on a
// timer, so "Auto-saves on pause" would be misleading.
function BeatStatusPip({ status, message }: { status: SaveStatus; message: string | null }) {
  if (status === 'idle') return <span />
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
