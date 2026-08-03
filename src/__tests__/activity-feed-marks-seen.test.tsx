/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import ActivityFeed from '@/components/ActivityFeed'
import type { FriendsFeedPage } from '@/lib/activity-feed'

const emptyPage: FriendsFeedPage = { items: [], page: 1, hasMore: false }

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }))),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ActivityFeed: mark seen on visit', () => {
  it('fires the seen POST on mount', async () => {
    render(<ActivityFeed initialFriends={emptyPage} initialIncoming={emptyPage} />)
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/activity/seen', { method: 'POST' })
    })
  })
})
