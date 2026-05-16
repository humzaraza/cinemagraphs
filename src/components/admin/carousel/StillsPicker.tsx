'use client'

import { useEffect, useState } from 'react'

export type Backdrop = {
  url: string
  thumbUrl: string
  width: number
  height: number
  voteAverage: number
  voteCount: number
  aspectRatio: number
}

export type FetchState =
  | { status: 'loading' }
  | { status: 'ready'; backdrops: Backdrop[] }
  | { status: 'error'; message: string }

interface Props {
  isOpen: boolean
  filmId: string
  filmTitle: string
  slideNumber: number
  slideLabel: string
  currentStillUrl: string | null
  onClose: () => void
  onApply: (stillUrl: string | null) => Promise<void>
}

export interface StillsPickerViewProps {
  filmTitle: string
  slideNumber: number
  slideLabel: string
  currentStillUrl: string | null
  fetchState: FetchState
  selectedUrl: string | null
  isApplying: boolean
  onClose: () => void
  onSelect: (url: string) => void
  onReset: () => void
  onApplyClick: () => void
}

export function StillsPicker(props: Props) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' })
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null)
  const [isApplying, setIsApplying] = useState(false)

  useEffect(() => {
    if (!props.isOpen) return
    let alive = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO(lint): fetch-on-mount pattern; revisit when migrating to Suspense or React Query
    setFetchState({ status: 'loading' })
    setSelectedUrl(null)
    setIsApplying(false)
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/carousel/film/${props.filmId}/stills`,
        )
        if (!alive) return
        if (!res.ok) {
          setFetchState({
            status: 'error',
            message: `Request failed (${res.status})`,
          })
          return
        }
        const json = (await res.json()) as { backdrops: Backdrop[] }
        if (!alive) return
        setFetchState({ status: 'ready', backdrops: json.backdrops ?? [] })
      } catch (err) {
        if (!alive) return
        const msg = err instanceof Error ? err.message : 'Unknown error'
        setFetchState({ status: 'error', message: msg })
      }
    })()
    return () => {
      alive = false
    }
  }, [props.isOpen, props.filmId])

  if (!props.isOpen) return null

  const doReset = async () => {
    if (isApplying) return
    setIsApplying(true)
    try {
      await props.onApply(null)
    } finally {
      setIsApplying(false)
    }
  }

  const doApply = async () => {
    if (!selectedUrl || isApplying) return
    setIsApplying(true)
    try {
      await props.onApply(selectedUrl)
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <StillsPickerView
      filmTitle={props.filmTitle}
      slideNumber={props.slideNumber}
      slideLabel={props.slideLabel}
      currentStillUrl={props.currentStillUrl}
      fetchState={fetchState}
      selectedUrl={selectedUrl}
      isApplying={isApplying}
      onClose={props.onClose}
      onSelect={setSelectedUrl}
      onReset={doReset}
      onApplyClick={doApply}
    />
  )
}

export function StillsPickerView(props: StillsPickerViewProps) {
  const { fetchState } = props
  return (
    <div className="fixed inset-0 z-50">
      <div
        onClick={props.onClose}
        className="absolute inset-0 bg-black/70"
        aria-hidden
      />
      <div
        role="dialog"
        aria-label={`Pick still for slide ${props.slideNumber}`}
        className="absolute top-0 right-0 bottom-0 w-[520px] bg-[#101020] border-l border-[#333] flex flex-col"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-[#333] gap-2">
          <div className="min-w-0">
            <div className="text-xs text-cinema-muted">
              Slide {props.slideNumber} — {props.slideLabel}
            </div>
            <h2 className="text-sm text-cinema-cream font-medium truncate">
              {props.filmTitle}
            </h2>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close stills picker"
            className="text-cinema-muted hover:text-cinema-cream text-xl px-2 shrink-0"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {fetchState.status === 'loading' && (
            <div
              data-testid="stills-loading"
              className="text-xs text-cinema-muted"
            >
              Loading stills…
            </div>
          )}
          {fetchState.status === 'error' && (
            <div data-testid="stills-error" className="text-xs text-red-300">
              Couldn&apos;t load stills: {fetchState.message}
            </div>
          )}
          {fetchState.status === 'ready' &&
            fetchState.backdrops.length === 0 && (
              <div
                data-testid="stills-empty"
                className="text-xs text-cinema-muted"
              >
                No TMDB stills available.
              </div>
            )}
          {fetchState.status === 'ready' &&
            fetchState.backdrops.length > 0 && (
              <div
                data-testid="stills-grid"
                className="grid grid-cols-2 gap-2"
              >
                {fetchState.backdrops.map((b) => {
                  const isSelected = props.selectedUrl === b.url
                  const isCurrent = props.currentStillUrl === b.url
                  return (
                    <button
                      key={b.url}
                      type="button"
                      onClick={() => props.onSelect(b.url)}
                      className={`relative aspect-[16/9] bg-cinema-dark overflow-hidden rounded border-2 ${
                        isSelected
                          ? 'border-cinema-gold'
                          : 'border-transparent hover:border-cinema-gold/40'
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={b.thumbUrl}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                      {isCurrent && (
                        <span className="absolute top-1 left-1 bg-cinema-gold text-[9px] px-1.5 py-0.5 rounded text-black font-medium tracking-wide">
                          CURRENT
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
        </div>

        <footer className="flex items-center justify-between px-4 py-3 border-t border-[#333] gap-2">
          <button
            type="button"
            onClick={props.onReset}
            disabled={props.isApplying}
            className="text-xs px-3 py-1.5 rounded border border-[#555] text-cinema-muted hover:border-cinema-cream/50 hover:text-cinema-cream disabled:opacity-50"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={props.onApplyClick}
            disabled={props.selectedUrl === null || props.isApplying}
            className="text-xs px-3 py-1.5 rounded border border-cinema-gold/50 text-cinema-gold hover:bg-cinema-gold/10 disabled:opacity-40"
          >
            {props.isApplying ? 'Applying…' : 'Apply still'}
          </button>
        </footer>
      </div>
    </div>
  )
}
