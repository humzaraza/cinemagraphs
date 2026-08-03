/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import Navigation from '@/components/Navigation'

// Mutable so individual tests can render signed in or signed out; the
// unread fetch is gated on the session.
const mocks = vi.hoisted(() => ({
  session: null as { user: { id: string; name?: string } } | null,
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: mocks.session,
    status: mocks.session ? 'authenticated' : 'unauthenticated',
  }),
  signIn: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/films/browse',
}))

let fetchMock: ReturnType<typeof vi.fn>

function stubUnread(unread: boolean) {
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ unread })))
  vi.stubGlobal('fetch', fetchMock)
}

// Drain the fetch promise chain inside act so React applies the resulting
// state updates before assertions run.
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  mocks.session = null
})

describe('Navigation: unread activity dot', () => {
  it('skips the unread fetch when there is no session', async () => {
    mocks.session = null
    stubUnread(true)
    render(<Navigation />)
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders the dot in the desktop nav and mobile drawer when unread is true', async () => {
    mocks.session = { user: { id: 'user-1', name: 'Test User' } }
    stubUnread(true)
    render(<Navigation />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/activity/unread')
    })
    await settle()
    // Both the desktop nav and the mobile drawer map navLinks, so the dot
    // (via its screen-reader text) appears once in each.
    expect(screen.getAllByText('unread activity')).toHaveLength(2)
  })

  it('renders no dot when unread is false', async () => {
    mocks.session = { user: { id: 'user-1', name: 'Test User' } }
    stubUnread(false)
    render(<Navigation />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/activity/unread')
    })
    await settle()
    expect(screen.queryByText('unread activity')).not.toBeInTheDocument()
  })
})
