/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import WatchlistButton from '@/components/WatchlistButton'

// WatchlistButton returns null when useSession reports no user, so the
// fetch effect never runs in that case. Mock a signed-in viewer to
// actually exercise the initialInWatchlist gating.
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 'user-1', name: 'Test User' } },
    status: 'authenticated',
  }),
}))

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ inWatchlist: true }))),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WatchlistButton: server-rendered initialInWatchlist', () => {
  it('does not fire the watchlist GET on mount when initialInWatchlist is true', () => {
    render(<WatchlistButton filmId="film-1" initialInWatchlist={true} />)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not fire the watchlist GET on mount when initialInWatchlist is false', () => {
    // The gate is `initialInWatchlist !== undefined`, so an explicit `false`
    // (viewer signed in but not on the watchlist) must also skip the fetch.
    render(<WatchlistButton filmId="film-1" initialInWatchlist={false} />)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fires the watchlist GET on mount when initialInWatchlist is absent and a viewer is signed in', async () => {
    render(<WatchlistButton filmId="film-1" />)
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/films/film-1/watchlist')
    })
  })
})
