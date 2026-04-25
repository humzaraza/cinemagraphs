import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  prisma: {
    film: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  },
  cronLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  invalidateHomepageCache: vi.fn(),
  invalidateFilmCache: vi.fn(),
  syncFilmCredits: vi.fn(),
  generateSentimentGraph: vi.fn(),
  generateAndStoreWikiBeats: vi.fn(),
  checkCronQualityGates: vi.fn(),
  getMovieDetails: vi.fn(),
  getMovieCredits: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ cronLogger: mocks.cronLogger }))
vi.mock('@/lib/cache', () => ({
  invalidateHomepageCache: mocks.invalidateHomepageCache,
  invalidateFilmCache: mocks.invalidateFilmCache,
}))
vi.mock('@/lib/person-sync', () => ({ syncFilmCredits: mocks.syncFilmCredits }))
vi.mock('@/lib/sentiment-pipeline', () => ({
  generateSentimentGraph: mocks.generateSentimentGraph,
}))
vi.mock('@/lib/wiki-beat-fallback', () => ({
  generateAndStoreWikiBeats: mocks.generateAndStoreWikiBeats,
}))
vi.mock('@/lib/cron-quality-gates', () => ({
  checkCronQualityGates: mocks.checkCronQualityGates,
}))
vi.mock('@/lib/tmdb', () => ({
  getMovieDetails: mocks.getMovieDetails,
  getMovieCredits: mocks.getMovieCredits,
}))

import { GET } from '@/app/api/cron/import-new-films/route'

type FindManyArg = {
  where?: Record<string, unknown>
  select?: Record<string, unknown>
}

function setupFetch(responses: Record<string, { id: number }[]>) {
  global.fetch = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input)
    for (const [key, results] of Object.entries(responses)) {
      if (url.includes(key)) {
        return { ok: true, json: async () => ({ results }) } as Response
      }
    }
    return { ok: true, json: async () => ({ results: [] }) } as Response
  }) as unknown as typeof fetch
}

/**
 * Route the dual `prisma.film.findMany` calls — "willFlip" pre-update
 * lookup vs. "existingSet" lookup — to different return values based on
 * the where clause shape. The first selects on `nowPlaying: false,
 * nowPlayingOverride: null, tmdbId: { in: [...] }`; the second selects
 * `tmdbId: { in: [...] }` only.
 */
function routeFindMany(
  willFlipReturn: unknown[],
  existingSetReturn: unknown[]
) {
  mocks.prisma.film.findMany.mockImplementation(async (args: FindManyArg) => {
    const where = args.where ?? {}
    const isWillFlipQuery =
      'nowPlaying' in where &&
      where.nowPlaying === false &&
      'nowPlayingOverride' in where &&
      where.nowPlayingOverride === null
    return isWillFlipQuery ? willFlipReturn : existingSetReturn
  })
}

describe('import-new-films cron: flip-triggered sentiment generation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prisma.film.findMany.mockResolvedValue([])
    mocks.prisma.film.updateMany.mockResolvedValue({ count: 0 })
    mocks.invalidateHomepageCache.mockResolvedValue(undefined)
    mocks.invalidateFilmCache.mockResolvedValue(undefined)
    mocks.generateSentimentGraph.mockResolvedValue(undefined)
    delete process.env.CRON_SECRET
  })

  it('triggers generateSentimentGraph for a film flipping false→true with no graph', async () => {
    setupFetch({
      'now_playing?page=1&region=CA': [{ id: 100 }],
    })
    routeFindMany(
      // willFlip lookup: a graphless film about to flip to nowPlaying=true
      [{ id: 'f100', title: 'Michael', tmdbId: 100, sentimentGraph: null }],
      // existingSet lookup: same film already exists, so no new-import branch
      [{ tmdbId: 100 }]
    )

    await GET(new Request('http://localhost/api/cron/import-new-films'))

    expect(mocks.generateSentimentGraph).toHaveBeenCalledTimes(1)
    expect(mocks.generateSentimentGraph).toHaveBeenCalledWith('f100', {
      callerPath: 'cron-analyze',
    })
    expect(mocks.invalidateFilmCache).toHaveBeenCalledWith('f100')
  })

  it('does NOT re-trigger for a film already nowPlaying=true', async () => {
    setupFetch({
      'now_playing?page=1&region=CA': [{ id: 200 }],
    })
    // willFlip lookup filters on nowPlaying=false — a film already
    // nowPlaying=true never appears in this result set.
    routeFindMany([], [{ tmdbId: 200 }])

    await GET(new Request('http://localhost/api/cron/import-new-films'))

    expect(mocks.generateSentimentGraph).not.toHaveBeenCalled()
  })

  it('does NOT trigger for a flipping film that already has a sentiment graph', async () => {
    setupFetch({
      'now_playing?page=1&region=CA': [{ id: 300 }],
    })
    routeFindMany(
      [
        {
          id: 'f300',
          title: 'Has Graph',
          tmdbId: 300,
          sentimentGraph: { id: 'g300' },
        },
      ],
      [{ tmdbId: 300 }]
    )

    await GET(new Request('http://localhost/api/cron/import-new-films'))

    expect(mocks.generateSentimentGraph).not.toHaveBeenCalled()
  })

  it('continues processing remaining flipped films when one generation throws', async () => {
    setupFetch({
      'now_playing?page=1&region=CA': [{ id: 401 }, { id: 402 }, { id: 403 }],
    })
    routeFindMany(
      [
        { id: 'f401', title: 'A', tmdbId: 401, sentimentGraph: null },
        { id: 'f402', title: 'B', tmdbId: 402, sentimentGraph: null },
        { id: 'f403', title: 'C', tmdbId: 403, sentimentGraph: null },
      ],
      [{ tmdbId: 401 }, { tmdbId: 402 }, { tmdbId: 403 }]
    )

    mocks.generateSentimentGraph.mockImplementation(async (filmId: string) => {
      if (filmId === 'f402') throw new Error('Anthropic 500')
    })

    await GET(new Request('http://localhost/api/cron/import-new-films'))

    expect(mocks.generateSentimentGraph).toHaveBeenCalledTimes(3)
    const calledIds = mocks.generateSentimentGraph.mock.calls.map(
      (c: unknown[]) => c[0]
    )
    expect(calledIds).toEqual(['f401', 'f402', 'f403'])
    // Cache invalidated only for successful generations.
    expect(mocks.invalidateFilmCache).toHaveBeenCalledTimes(2)
  })

  it('skips the willFlip query entirely when nowPlayingIds is empty', async () => {
    setupFetch({})
    // willFlip return wouldn't matter — the query shouldn't run at all.
    routeFindMany(
      [{ id: 'fX', title: 'X', tmdbId: 999, sentimentGraph: null }],
      []
    )

    await GET(new Request('http://localhost/api/cron/import-new-films'))

    // No findMany call should match the willFlip shape.
    const willFlipCalls = mocks.prisma.film.findMany.mock.calls.filter(
      (c: unknown[]) => {
        const arg = c[0] as FindManyArg
        const where = arg.where ?? {}
        return (
          'nowPlaying' in where &&
          where.nowPlaying === false &&
          'nowPlayingOverride' in where &&
          where.nowPlayingOverride === null
        )
      }
    )
    expect(willFlipCalls).toHaveLength(0)
    expect(mocks.generateSentimentGraph).not.toHaveBeenCalled()
  })
})
