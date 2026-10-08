import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  prisma: {
    film: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    siteSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  cronLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  filmNeedsReanalysis: vi.fn(),
  prepareSentimentGraphInput: vi.fn(),
  storeSentimentGraphResult: vi.fn(),
  analyzeSentimentBatch: vi.fn(),
  fetchBatchResults: vi.fn(),
  getBatchStatus: vi.fn(),
  estimateSentimentCost: vi.fn(() => 0),
  sumUsage: vi.fn(),
  invalidateFilmCache: vi.fn(),
  invalidateHomepageCache: vi.fn(),
  decideCronRegen: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ cronLogger: mocks.cronLogger }))
vi.mock('@/lib/cache', () => ({
  invalidateFilmCache: mocks.invalidateFilmCache,
  invalidateHomepageCache: mocks.invalidateHomepageCache,
}))
vi.mock('@/lib/sentiment-pipeline', () => ({
  filmNeedsReanalysis: mocks.filmNeedsReanalysis,
  prepareSentimentGraphInput: mocks.prepareSentimentGraphInput,
  storeSentimentGraphResult: mocks.storeSentimentGraphResult,
}))
vi.mock('@/lib/claude', () => ({
  analyzeSentimentBatch: mocks.analyzeSentimentBatch,
  fetchBatchResults: mocks.fetchBatchResults,
  getBatchStatus: mocks.getBatchStatus,
  estimateSentimentCost: mocks.estimateSentimentCost,
  sumUsage: mocks.sumUsage,
}))
vi.mock('@/lib/cron-skip-logic', () => ({
  decideCronRegen: mocks.decideCronRegen,
}))

import { GET } from '@/app/api/cron/analyze/route'

type FindManyArg = {
  where?: {
    sentimentGraph?: { is?: null; isNot?: null }
    [k: string]: unknown
  }
  orderBy?: unknown
  take?: number
}

describe('analyze cron: two-phase candidate ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prisma.siteSettings.findUnique.mockResolvedValue(null) // no pending batch
    mocks.prisma.siteSettings.upsert.mockResolvedValue(undefined)
    mocks.prisma.siteSettings.deleteMany.mockResolvedValue(undefined)
    mocks.invalidateHomepageCache.mockResolvedValue(undefined)
    mocks.invalidateFilmCache.mockResolvedValue(undefined)
    delete process.env.CRON_SECRET
  })

  it('issues two distinct findMany calls — graphless first, then graphed', async () => {
    mocks.prisma.film.findMany.mockResolvedValue([])

    await GET(new Request('http://localhost/api/cron/analyze'))

    const calls: FindManyArg[] = mocks.prisma.film.findMany.mock.calls.map(
      (c: unknown[]) => c[0] as FindManyArg
    )

    const noGraphCall = calls.find(
      (c) => c.where?.sentimentGraph?.is === null
    )
    const withGraphCall = calls.find(
      (c) => c.where?.sentimentGraph?.isNot === null
    )

    expect(noGraphCall).toBeDefined()
    expect(noGraphCall!.orderBy).toEqual({ createdAt: 'asc' })
    expect(noGraphCall!.take).toBe(200)

    // The withGraph call is conditional on remaining budget. With no graphless
    // films returned, remaining = 200, so the second query DOES run.
    expect(withGraphCall).toBeDefined()
    expect(withGraphCall!.orderBy).toEqual([
      { sentimentGraph: { generatedAt: 'asc' } },
      { createdAt: 'asc' },
    ])
    expect(withGraphCall!.take).toBe(200)
  })

  it('shrinks the second-phase take by the number of graphless candidates returned', async () => {
    // First call (graphless) returns 50 films; second call should take 150.
    const graphlessFilms = Array.from({ length: 50 }, (_, i) => ({
      id: `ng${i}`,
      title: `NoGraph ${i}`,
      releaseDate: new Date('2026-01-01'),
      lastReviewCount: 0,
      sentimentGraph: null,
      createdAt: new Date('2026-03-01'),
    }))

    mocks.prisma.film.findMany.mockImplementation(async (args: FindManyArg) => {
      if (args.where?.sentimentGraph?.is === null) return graphlessFilms
      return []
    })
    mocks.decideCronRegen.mockReturnValue({ skip: false, reason: 'eligible_no_graph' })
    mocks.filmNeedsReanalysis.mockResolvedValue({
      needsAnalysis: false,
      filteredCount: 0,
      reason: 'no reviews',
    })

    await GET(new Request('http://localhost/api/cron/analyze'))

    const calls: FindManyArg[] = mocks.prisma.film.findMany.mock.calls.map(
      (c: unknown[]) => c[0] as FindManyArg
    )
    const withGraphCall = calls.find(
      (c) => c.where?.sentimentGraph?.isNot === null
    )
    expect(withGraphCall).toBeDefined()
    expect(withGraphCall!.take).toBe(150)
  })

  it('skips the second-phase query when graphless candidates already fill the budget', async () => {
    const graphlessFilms = Array.from({ length: 200 }, (_, i) => ({
      id: `ng${i}`,
      title: `NoGraph ${i}`,
      releaseDate: new Date('2026-01-01'),
      lastReviewCount: 0,
      sentimentGraph: null,
      createdAt: new Date('2026-03-01'),
    }))

    mocks.prisma.film.findMany.mockImplementation(async (args: FindManyArg) => {
      if (args.where?.sentimentGraph?.is === null) return graphlessFilms
      throw new Error('with-graph query should not run when budget is full')
    })
    mocks.decideCronRegen.mockReturnValue({ skip: false, reason: 'eligible_no_graph' })
    mocks.filmNeedsReanalysis.mockResolvedValue({
      needsAnalysis: false,
      filteredCount: 0,
      reason: 'no reviews',
    })

    await GET(new Request('http://localhost/api/cron/analyze'))

    const calls: FindManyArg[] = mocks.prisma.film.findMany.mock.calls.map(
      (c: unknown[]) => c[0] as FindManyArg
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].where?.sentimentGraph?.is).toBe(null)
  })

  it('passes graphless candidates to decideCronRegen BEFORE graphed candidates (priority order)', async () => {
    const graphlessFilm = {
      id: 'noGraph',
      title: 'NoGraph',
      releaseDate: new Date('2026-01-01'),
      lastReviewCount: 0,
      sentimentGraph: null,
      createdAt: new Date('2026-03-01'),
    }
    const graphedFilm = {
      id: 'hasGraph',
      title: 'HasGraph',
      releaseDate: new Date('2026-01-01'),
      lastReviewCount: 20,
      sentimentGraph: { id: 'g1', generatedAt: new Date('2026-04-01') },
      createdAt: new Date('2026-02-01'),
    }

    mocks.prisma.film.findMany.mockImplementation(async (args: FindManyArg) => {
      if (args.where?.sentimentGraph?.is === null) return [graphlessFilm]
      if (args.where?.sentimentGraph?.isNot === null) return [graphedFilm]
      return []
    })
    mocks.decideCronRegen.mockReturnValue({ skip: true, reason: 'skipped_mature_stable' })

    await GET(new Request('http://localhost/api/cron/analyze'))

    const decideCalls = mocks.decideCronRegen.mock.calls.map(
      (c: unknown[]) => (c[0] as { releaseDate: Date | null }) // dummy cast for ordering check
    )
    // First call is for the graphless film; second is the graphed film.
    expect(decideCalls).toHaveLength(2)
    // We can't check id because decideCronRegen receives a derived input, not
    // the film row — but we can infer ordering from lastRegenAt being null vs.
    // a real date.
    const decideArgs = mocks.decideCronRegen.mock.calls.map(
      (c: unknown[]) => c[0] as { lastRegenAt: Date | null }
    )
    expect(decideArgs[0].lastRegenAt).toBeNull() // graphless
    expect(decideArgs[1].lastRegenAt).not.toBeNull() // graphed
  })
})

describe('analyze cron: resumed batch carries plotSource to the store', () => {
  const film = {
    id: 'film-1',
    title: 'Test Film',
    imdbRating: null,
    rtCriticsScore: null,
    rtAudienceScore: null,
    metacriticScore: null,
  }

  function pendingState(job: Record<string, unknown>) {
    return {
      key: 'pending_sentiment_batch',
      value: {
        batchId: 'batch-1',
        submittedAt: new Date().toISOString(),
        jobs: [{ filmId: 'film-1', reviewHash: 'hash-1', filteredReviewCount: 7, sources: ['tmdb'], ...job }],
      },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prisma.siteSettings.upsert.mockResolvedValue(undefined)
    mocks.prisma.siteSettings.deleteMany.mockResolvedValue(undefined)
    mocks.prisma.film.findUnique.mockResolvedValue(film)
    mocks.invalidateHomepageCache.mockResolvedValue(undefined)
    mocks.invalidateFilmCache.mockResolvedValue(undefined)
    mocks.getBatchStatus.mockResolvedValue({
      processingStatus: 'ended',
      requestCounts: { processing: 0, succeeded: 1 },
    })
    mocks.fetchBatchResults.mockResolvedValue([
      { customId: 'film-1', outcome: 'succeeded', data: { dataPoints: [] } },
    ])
    mocks.storeSentimentGraphResult.mockResolvedValue(undefined)
    delete process.env.CRON_SECRET
  })

  it('passes the stored job plotSource through to storeSentimentGraphResult', async () => {
    mocks.prisma.siteSettings.findUnique.mockResolvedValue(pendingState({ plotSource: 'wikipedia' }))

    const res = await GET(new Request('http://localhost/api/cron/analyze'))
    expect(res.status).toBe(200)

    expect(mocks.storeSentimentGraphResult).toHaveBeenCalledTimes(1)
    const input = mocks.storeSentimentGraphResult.mock.calls[0][0]
    expect(input.plotSource).toBe('wikipedia')
    expect(input.filteredReviewCount).toBe(7)
    expect(input.reviewHash).toBe('hash-1')
  })

  it('a stored job without plotSource passes undefined and does not throw', async () => {
    mocks.prisma.siteSettings.findUnique.mockResolvedValue(pendingState({}))

    const res = await GET(new Request('http://localhost/api/cron/analyze'))
    expect(res.status).toBe(200)

    expect(mocks.storeSentimentGraphResult).toHaveBeenCalledTimes(1)
    const input = mocks.storeSentimentGraphResult.mock.calls[0][0]
    expect(input.plotSource).toBeUndefined()
    expect(mocks.cronLogger.error).not.toHaveBeenCalled()
  })
})
