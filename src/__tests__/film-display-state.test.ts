import { describe, it, expect } from 'vitest'
import { getFilmDisplayState } from '@/lib/film-display-state'
import type { SentimentGraph } from '@/generated/prisma/client'

function makeGraph(reviewCount: number): SentimentGraph {
  // Only the shape matters here; getFilmDisplayState doesn't read the payload.
  return {
    id: 'g1',
    filmId: 'f1',
    overallScore: 7.2,
    previousScore: null,
    anchoredFrom: 'imdb',
    dataPoints: [],
    peakMoment: null,
    lowestMoment: null,
    biggestSwing: null,
    summary: null,
    reviewCount,
    sourcesUsed: [],
    generatedAt: new Date(),
    varianceSource: 'external_only',
    version: 1,
    reviewHash: null,
  } as SentimentGraph
}

describe('getFilmDisplayState', () => {
  it("returns 'coming_soon' when releaseDate is in the future, even with a graph", () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const graph = makeGraph(50)
    const state = getFilmDisplayState({ releaseDate: future }, graph, 50)

    expect(state.kind).toBe('coming_soon')
    if (state.kind === 'coming_soon') {
      expect(state.releaseDate).toBe(future)
    }
  })

  it("returns 'not_enough_reviews' when the graph is null (released film)", () => {
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const state = getFilmDisplayState({ releaseDate: past }, null, 0)

    expect(state.kind).toBe('not_enough_reviews')
    if (state.kind === 'not_enough_reviews') {
      expect(state.reviewCount).toBe(0)
    }
  })

  it("returns 'not_enough_reviews' when reviewCount is below 3", () => {
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const graph = makeGraph(2)
    const state = getFilmDisplayState({ releaseDate: past }, graph, 2)

    expect(state.kind).toBe('not_enough_reviews')
    if (state.kind === 'not_enough_reviews') {
      expect(state.reviewCount).toBe(2)
    }
  })

  it("returns 'graph' when released, graph exists, and reviewCount >= 3", () => {
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const graph = makeGraph(3)
    const state = getFilmDisplayState({ releaseDate: past }, graph, 3)

    expect(state.kind).toBe('graph')
    if (state.kind === 'graph') {
      expect(state.sentimentGraph).toBe(graph)
    }
  })

  it("treats a null releaseDate as released (e.g. legacy film with missing date)", () => {
    const graph = makeGraph(10)
    const state = getFilmDisplayState({ releaseDate: null }, graph, 10)

    expect(state.kind).toBe('graph')
  })

  it("pre-release precedence: future releaseDate + null graph still returns 'coming_soon'", () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const state = getFilmDisplayState({ releaseDate: future }, null, 0)

    expect(state.kind).toBe('coming_soon')
  })
})
