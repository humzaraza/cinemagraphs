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

type UpdateManyArg = {
  where?: {
    nowPlaying?: boolean
    nowPlayingOverride?: string | null
    tmdbId?: { in?: number[]; notIn?: number[] }
  }
  data?: { nowPlaying?: boolean }
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

describe('import-new-films cron: regional now_playing scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prisma.film.findMany.mockResolvedValue([])
    mocks.prisma.film.updateMany.mockResolvedValue({ count: 0 })
    mocks.invalidateHomepageCache.mockResolvedValue(undefined)
    delete process.env.CRON_SECRET
  })

  it('fetches /movie/now_playing for both CA and US across pages 1-3 (6 calls total)', async () => {
    setupFetch({})

    await GET(new Request('http://localhost/api/cron/import-new-films'))

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    )
    const nowPlayingCalls = calls.filter((u) => u.includes('/movie/now_playing'))
    expect(nowPlayingCalls).toHaveLength(6)
    expect(nowPlayingCalls.filter((u) => u.includes('region=CA'))).toHaveLength(3)
    expect(nowPlayingCalls.filter((u) => u.includes('region=US'))).toHaveLength(3)
    // Upcoming stays region-agnostic (out of scope for this chunk).
    const upcomingCalls = calls.filter((u) => u.includes('/movie/upcoming'))
    expect(upcomingCalls.every((u) => !u.includes('region='))).toBe(true)
  })

  it('dedupes a film playing in both regions into a single tmdbId', async () => {
    // Film 2 appears in BOTH regions; films 1 and 3 appear in only one.
    setupFetch({
      'now_playing?page=1&region=CA': [{ id: 1 }, { id: 2 }],
      'now_playing?page=1&region=US': [{ id: 2 }, { id: 3 }],
    })
    // All three already exist; no new-film branch runs.
    mocks.prisma.film.findMany.mockResolvedValue([
      { tmdbId: 1 },
      { tmdbId: 2 },
      { tmdbId: 3 },
    ])

    await GET(new Request('http://localhost/api/cron/import-new-films'))

    const updateManyCalls: UpdateManyArg[] = mocks.prisma.film.updateMany.mock.calls.map(
      (c: unknown[]) => c[0] as UpdateManyArg
    )
    const turnOn = updateManyCalls.find(
      (arg) =>
        arg.where?.nowPlayingOverride === null &&
        arg.where?.tmdbId?.in != null &&
        arg.data?.nowPlaying === true
    )
    expect(turnOn).toBeDefined()
    const ids = turnOn!.where!.tmdbId!.in!
    expect(ids).toHaveLength(3)
    expect(new Set(ids)).toEqual(new Set([1, 2, 3]))
  })

  it('demotes films no longer in EITHER region via notIn(union) (demotion logic intact)', async () => {
    // Only id=10 in CA, id=20 in US; nothing else.
    setupFetch({
      'now_playing?page=1&region=CA': [{ id: 10 }],
      'now_playing?page=1&region=US': [{ id: 20 }],
    })
    mocks.prisma.film.findMany.mockResolvedValue([{ tmdbId: 10 }, { tmdbId: 20 }])

    await GET(new Request('http://localhost/api/cron/import-new-films'))

    const updateManyCalls: UpdateManyArg[] = mocks.prisma.film.updateMany.mock.calls.map(
      (c: unknown[]) => c[0] as UpdateManyArg
    )
    const demote = updateManyCalls.find(
      (arg) =>
        arg.where?.nowPlaying === true &&
        arg.where?.nowPlayingOverride === null &&
        arg.data?.nowPlaying === false &&
        arg.where?.tmdbId?.notIn != null
    )
    expect(demote).toBeDefined()
    const notInIds = demote!.where!.tmdbId!.notIn!
    // The union of what's "still in theaters" is {10, 20}. Any auto-managed DB
    // film whose tmdbId is NOT in that set and currently has nowPlaying=true
    // gets flipped to false. A film in neither region would match this notIn
    // clause and be demoted.
    expect(new Set(notInIds)).toEqual(new Set([10, 20]))
  })
})
