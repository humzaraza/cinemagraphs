/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}))

vi.mock('@/components/FilmCard', () => ({
  default: () => null,
}))

import BrowsePage from '@/app/films/browse/page'

const realFetch = globalThis.fetch
let fetchMock: ReturnType<typeof vi.fn>

function okFilms(films: unknown[] = [], total = 0) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ films, pagination: { total, totalPages: 1 } }),
  }
}

function errorResponse(status: number, headers?: Record<string, string>) {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => ({ error: 'test' }),
  }
}

function badJsonResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0')
    },
  }
}

// Drain the fetch promise chain inside act so React applies the resulting
// state updates before assertions run.
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock as unknown as typeof fetch
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Browse films error state', () => {
  it('shows the generic error block when the films API returns 500', async () => {
    fetchMock.mockResolvedValue(errorResponse(500))
    render(<BrowsePage />)

    expect(await screen.findByText(/couldn.t load films/i)).toBeInTheDocument()
    expect(screen.getByText(/something went wrong on our end/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled()
  })

  it('shows the rate-limited block with a 15s countdown on a 429', async () => {
    fetchMock.mockResolvedValue(errorResponse(429, { 'Retry-After': '15' }))
    render(<BrowsePage />)

    expect(await screen.findByText(/slow down a moment/i)).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /try again in 15s/i })
    expect(button).toBeDisabled()
  })

  it('defaults the countdown to 30s when a 429 has no Retry-After header', async () => {
    fetchMock.mockResolvedValue(errorResponse(429))
    render(<BrowsePage />)

    expect(
      await screen.findByRole('button', { name: /try again in 30s/i }),
    ).toBeInTheDocument()
  })

  it('shows the generic error and clears loading when the fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<BrowsePage />)

    expect(await screen.findByText(/couldn.t load films/i)).toBeInTheDocument()
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('shows the generic error and clears loading when the body is not JSON', async () => {
    fetchMock.mockResolvedValue(badJsonResponse())
    render(<BrowsePage />)

    expect(await screen.findByText(/couldn.t load films/i)).toBeInTheDocument()
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('refetches when the retry button is clicked', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValue(okFilms([], 0))
    render(<BrowsePage />)

    const button = await screen.findByRole('button', { name: /try again/i })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.click(button)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No films available yet.')).toBeInTheDocument()
  })

  it('debounces rapid query input into a single fetch', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(okFilms([], 0))

    render(<BrowsePage />)
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const input = screen.getByPlaceholderText('Search by title...')
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.change(input, { target: { value: 'ab' } })
    fireEvent.change(input, { target: { value: 'abc' } })

    // Still inside the 300ms debounce window: no new fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Crossing 300ms idle fires exactly one debounced fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
