'use client'

import { useEffect, useRef, useState } from 'react'
import { signIn } from 'next-auth/react'

export type LikeButtonMode = 'interactive' | 'readonly' | 'signin'

interface LikeButtonProps {
  reviewId: string
  initialCount: number
  initialLiked: boolean
  mode: LikeButtonMode
}

// Classic heart path; works filled (gold) or as an outline (fillOpacity 0).
const HEART_PATH =
  'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'

export default function LikeButton({
  reviewId,
  initialCount,
  initialLiked,
  mode,
}: LikeButtonProps) {
  const [count, setCount] = useState(initialCount)
  const [liked, setLiked] = useState(initialLiked)
  const [inFlight, setInFlight] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [popping, setPopping] = useState(false)
  const [signinPrompt, setSigninPrompt] = useState(false)

  const touchedRef = useRef(false)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const signinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartRef = useRef<SVGSVGElement | null>(null)

  // Hydration: initialCount/initialLiked arrive a beat after mount because the
  // batch fetch is async. Sync from props ONLY until the user first interacts.
  // Once touched, ignore late prop changes so a stale batch result cannot
  // clobber the user's action or the authoritative server response. In the
  // signin and readonly modes touchedRef never flips, so count always tracks
  // the props.
  useEffect(() => {
    if (touchedRef.current) return
    setCount(initialCount)
    setLiked(initialLiked)
  }, [initialCount, initialLiked])

  // Drop pending timers on unmount.
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
      if (popTimerRef.current) clearTimeout(popTimerRef.current)
      if (signinTimerRef.current) clearTimeout(signinTimerRef.current)
    }
  }, [])

  function triggerPop() {
    setPopping(true)
    if (popTimerRef.current) clearTimeout(popTimerRef.current)
    popTimerRef.current = setTimeout(() => setPopping(false), 300)
  }

  async function handleClick() {
    if (inFlight) return
    touchedRef.current = true

    const prev = { count, liked }
    const newLiked = !liked

    // Reset any lingering error before the new attempt.
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current)
      errorTimerRef.current = null
    }
    setError(null)
    setInFlight(true)

    // Optimistic update.
    setLiked(newLiked)
    setCount((c) => c + (newLiked ? 1 : -1))
    if (newLiked) triggerPop()

    try {
      const res = await fetch(`/api/reviews/${reviewId}/like`, {
        method: newLiked ? 'POST' : 'DELETE',
      })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const data = (await res.json()) as { liked: boolean; count: number }
      // Authoritative response self-heals any drift.
      setLiked(data.liked)
      setCount(data.count)
    } catch {
      // Revert, then show a transient inline error that auto-clears.
      setLiked(prev.liked)
      setCount(prev.count)
      setError("couldn't save")
      errorTimerRef.current = setTimeout(() => {
        setError(null)
        errorTimerRef.current = null
      }, 3000)
    } finally {
      setInFlight(false)
    }
  }

  function handleSigninClick() {
    // Bounce-back: the heart tips toward gold with a slight scale, then
    // springs back to the outline. This is animation only; liked/count never
    // change and no request fires, so the heart cannot rest filled.
    const el = heartRef.current
    if (el) {
      el.getAnimations().forEach((a) => a.cancel())
      el.animate(
        [
          { transform: 'scale(1)', fillOpacity: 0 },
          { transform: 'scale(1.2)', fillOpacity: 0.7, offset: 0.5 },
          { transform: 'scale(1)', fillOpacity: 0 },
        ],
        { duration: 250, easing: 'ease-out' },
      )
    }

    // One prompt per button; a re-click resets the dismiss timer.
    setSigninPrompt(true)
    if (signinTimerRef.current) clearTimeout(signinTimerRef.current)
    signinTimerRef.current = setTimeout(() => {
      setSigninPrompt(false)
      signinTimerRef.current = null
    }, 4000)
  }

  const heart = (
    <svg
      ref={heartRef}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="var(--cinema-gold)"
      stroke={liked ? 'var(--cinema-gold)' : 'var(--cinema-cream)'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        fillOpacity: liked ? 1 : 0,
        opacity: mode === 'readonly' ? 0.55 : liked ? 1 : 0.55,
        transform: popping ? 'scale(1.25)' : 'scale(1)',
        transition: 'transform 300ms ease-out',
      }}
    >
      <path d={HEART_PATH} />
    </svg>
  )

  const countStyle = { color: liked ? 'var(--cinema-gold)' : 'var(--cinema-muted)' }

  if (mode === 'readonly') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-sm"
        aria-label={`${count} ${count === 1 ? 'like' : 'likes'}`}
      >
        {heart}
        <span style={countStyle}>{count}</span>
      </span>
    )
  }

  if (mode === 'signin') {
    return (
      <div className="inline-flex items-center gap-2">
        <button
          type="button"
          onClick={handleSigninClick}
          aria-label="Sign in to like this review"
          className="inline-flex items-center gap-1.5 text-sm rounded transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-cinema-gold/50"
        >
          {heart}
          <span style={countStyle}>{count}</span>
        </button>
        {signinPrompt && (
          <span className="text-xs text-cinema-muted whitespace-nowrap">
            <button
              type="button"
              onClick={() => signIn()}
              className="text-cinema-gold underline underline-offset-2 hover:text-cinema-gold/80"
            >
              Sign in
            </button>{' '}
            to like
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        aria-pressed={liked}
        aria-label={liked ? 'Unlike this review' : 'Like this review'}
        className="inline-flex items-center gap-1.5 text-sm rounded transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-cinema-gold/50"
      >
        {heart}
        <span style={countStyle}>{count}</span>
      </button>
      {error && (
        <span className="text-xs" style={{ color: '#f87171' }}>
          {error}
        </span>
      )}
    </div>
  )
}
