/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import SentimentGraph from '@/components/SentimentGraph'

// Matches SentimentGraph's internal AudienceData interface (structural).
const audienceData = {
  userReviewCount: 0,
  beatAverages: {},
  liveSessionCount: 0,
  reactionScores: [],
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(audienceData))),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SentimentGraph: server-rendered initialAudienceData', () => {
  it('does not fire the audience-data GET on mount when initialAudienceData is provided', () => {
    // Passing dataPoints=[] takes the lightweight empty-state branch (no
    // recharts render), but the audience-data effect still runs because the
    // hooks above the early return are unaffected. That is exactly the
    // behavior under test.
    render(
      <SentimentGraph
        dataPoints={[]}
        overallScore={7}
        filmId="film-1"
        initialAudienceData={audienceData}
      />,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls back to the on-mount audience-data GET when initialAudienceData is absent', async () => {
    render(<SentimentGraph dataPoints={[]} overallScore={7} filmId="film-1" />)
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/films/film-1/audience-data')
    })
  })
})
