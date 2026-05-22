'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'

interface Props {
  filmId: string
  size?: 'sm' | 'md'
  className?: string
  /**
   * Server-rendered watchlist membership for the signed-in viewer. When
   * defined, the component seeds its state from it and skips the on-mount
   * GET. Left undefined when the server render had no session, so a
   * client-side sign-in still triggers the fetch.
   */
  initialInWatchlist?: boolean
}

export default function WatchlistButton({
  filmId,
  size = 'md',
  className = '',
  initialInWatchlist,
}: Props) {
  const { data: session } = useSession()
  const [inWatchlist, setInWatchlist] = useState(initialInWatchlist ?? false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!session?.user?.id) return
    // Watchlist status is server-rendered via initialInWatchlist; skip the fetch.
    if (initialInWatchlist !== undefined) return
    fetch(`/api/films/${filmId}/watchlist`)
      .then((r) => r.json())
      .then((data) => setInWatchlist(data.inWatchlist))
      .catch(() => {})
  }, [filmId, session?.user?.id, initialInWatchlist])

  if (!session?.user?.id) return null

  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setLoading(true)
    try {
      const res = await fetch(`/api/films/${filmId}/watchlist`, {
        method: inWatchlist ? 'DELETE' : 'POST',
      })
      if (res.ok) {
        setInWatchlist(!inWatchlist)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  const iconSize = size === 'sm' ? 16 : 20

  return (
    <button
      onClick={toggle}
      disabled={loading}
      className={`transition-all ${loading ? 'opacity-50' : ''} ${className}`}
      aria-label={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
      title={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill={inWatchlist ? 'var(--cinema-gold)' : 'none'}
        stroke="var(--cinema-gold)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  )
}
