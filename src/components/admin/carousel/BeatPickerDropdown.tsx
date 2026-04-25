'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

export type AvailableBeat = {
  beatIndex: number
  title: string
  timestamp: string
  score: number
  color: 'red' | 'gold' | 'teal'
}

interface Props {
  beats: AvailableBeat[]
  selectedBeatIndex: number | null
  slotLabel: string
  onChange: (beatIndex: number) => void
  disabled?: boolean
}

const TITLE_TRUNCATE = 50

const DOT_BG: Record<AvailableBeat['color'], string> = {
  red: 'bg-red-400',
  gold: 'bg-cinema-gold',
  teal: 'bg-cinema-teal',
}

const DOT_TEXT: Record<AvailableBeat['color'], string> = {
  red: 'text-red-300',
  gold: 'text-cinema-gold',
  teal: 'text-cinema-teal',
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + '…'
}

export function BeatPickerDropdown({
  beats,
  selectedBeatIndex,
  slotLabel,
  onChange,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false)
  // Active row for keyboard nav. -1 means "no active highlight". On open, it
  // initializes to the selected index so arrow keys feel anchored.
  const [activeIdx, setActiveIdx] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selected = beats.find((b) => b.beatIndex === selectedBeatIndex) ?? null

  const close = useCallback(() => {
    setOpen(false)
    setActiveIdx(-1)
  }, [])

  // Click outside the root closes the menu.
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      close()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open, close])

  // Scroll the active option into view as the user arrows through.
  useEffect(() => {
    if (!open || activeIdx < 0) return
    const list = listRef.current
    if (!list) return
    const node = list.children[activeIdx] as HTMLElement | undefined
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIdx, open])

  function handleTriggerClick() {
    if (disabled) return
    if (open) {
      close()
      return
    }
    setOpen(true)
    const initial = beats.findIndex((b) => b.beatIndex === selectedBeatIndex)
    setActiveIdx(initial === -1 ? 0 : initial)
  }

  function handleTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        const initial = beats.findIndex((b) => b.beatIndex === selectedBeatIndex)
        setActiveIdx(initial === -1 ? 0 : initial)
      }
    }
  }

  function handleListKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(beats.length - 1, (i < 0 ? -1 : i) + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, (i < 0 ? 1 : i) - 1))
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setActiveIdx(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      setActiveIdx(beats.length - 1)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (activeIdx >= 0 && activeIdx < beats.length) {
        const beat = beats[activeIdx]
        if (beat.beatIndex !== selectedBeatIndex) {
          onChange(beat.beatIndex)
        }
        close()
      }
    }
  }

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${slotLabel} beat`}
        className={`w-full flex items-center gap-2 bg-cinema-dark border rounded px-2.5 py-1.5 text-sm transition-colors ${
          disabled
            ? 'border-[#222] text-cinema-muted/50 cursor-not-allowed'
            : open
              ? 'border-cinema-gold/60 text-cinema-cream'
              : 'border-[#333] text-cinema-cream hover:border-cinema-gold/30'
        }`}
      >
        {selected ? (
          <>
            <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${DOT_BG[selected.color]}`} />
            <span className="text-cinema-muted text-[11px] tabular-nums shrink-0">
              {selected.timestamp}
            </span>
            <span className="text-cinema-cream truncate flex-1 text-left">
              {truncate(selected.title || '—', TITLE_TRUNCATE)}
            </span>
            <span className={`text-[11px] tabular-nums shrink-0 ${DOT_TEXT[selected.color]}`}>
              {selected.score.toFixed(1)}
            </span>
          </>
        ) : (
          <span className="text-cinema-muted text-left flex-1">No beat</span>
        )}
        <span className="text-cinema-muted text-xs shrink-0" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <ul
          // Single ref callback: stash the node and force initial keyboard
          // focus so arrow keys work the moment the menu opens.
          ref={(node) => {
            listRef.current = node
            if (node) node.focus()
          }}
          role="listbox"
          tabIndex={-1}
          aria-label={`Beats for ${slotLabel}`}
          onKeyDown={handleListKeyDown}
          // Stop bubbled mousedown from immediately re-closing (we still want
          // the document listener for clicks outside).
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute z-30 left-0 right-0 top-full mt-1 max-h-64 overflow-y-auto bg-cinema-dark border border-[#333] rounded-lg shadow-xl outline-none"
        >
          {beats.map((b, i) => {
            const isSelected = b.beatIndex === selectedBeatIndex
            const isActive = i === activeIdx
            return (
              <li
                key={b.beatIndex}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => {
                  if (b.beatIndex !== selectedBeatIndex) onChange(b.beatIndex)
                  close()
                }}
                className={`flex items-center gap-2 px-2.5 py-1.5 text-sm cursor-pointer ${
                  isActive ? 'bg-white/5' : ''
                } ${isSelected ? 'text-cinema-gold' : 'text-cinema-cream'}`}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${DOT_BG[b.color]}`} />
                <span className="text-cinema-muted text-[11px] tabular-nums shrink-0 w-16">
                  {b.timestamp}
                </span>
                <span className="truncate flex-1">
                  {truncate(b.title || '—', TITLE_TRUNCATE)}
                </span>
                <span className={`text-[11px] tabular-nums shrink-0 ${DOT_TEXT[b.color]}`}>
                  {b.score.toFixed(1)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
