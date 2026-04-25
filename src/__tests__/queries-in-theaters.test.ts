import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  prisma: {
    film: {
      findMany: vi.fn(),
    },
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))

import { getInTheatersFilms } from '@/lib/queries'

// ── Fixtures ───────────────────────────────────────────────────
const NOW = new Date('2026-04-24T12:00:00.000Z')
const PAST = new Date('2025-01-15T00:00:00.000Z')
const FUTURE = new Date('2026-12-25T00:00:00.000Z')

type FilmFixture = {
  id: string
  title: string
  status: 'ACTIVE' | 'ARCHIVED'
  nowPlaying: boolean
  nowPlayingOverride: string | null
  releaseDate: Date | null
  sentimentGraph: { overallScore: number; dataPoints: unknown } | null
}

function makeFilm(overrides: Partial<FilmFixture>): FilmFixture {
  return {
    id: overrides.id ?? 'f',
    title: overrides.id ?? 'Film',
    status: 'ACTIVE',
    nowPlaying: false,
    nowPlayingOverride: null,
    releaseDate: PAST,
    sentimentGraph: { overallScore: 7.2, dataPoints: [{ score: 7.2 }] },
    ...overrides,
  }
}

// ── Minimal where-clause simulator ──────────────────────────────
// Reproduces the exact subset of Prisma where-semantics that getInTheatersFilms
// uses so tests exercise the SQL gate AND the app-level sparkline gate end to end.
type WhereArg = {
  status?: 'ACTIVE' | 'ARCHIVED'
  releaseDate?: { not?: null; lte?: Date }
  NOT?: { nowPlayingOverride?: string }
  OR?: Array<{ nowPlayingOverride?: string; nowPlaying?: boolean }>
  sentimentGraph?: { isNot?: null }
}

function applyWhere(films: FilmFixture[], where: WhereArg): FilmFixture[] {
  return films.filter((f) => {
    if (where.status && f.status !== where.status) return false
    if (where.releaseDate?.not === null && f.releaseDate === null) return false
    if (
      where.releaseDate?.lte &&
      (f.releaseDate === null || f.releaseDate > where.releaseDate.lte)
    ) {
      return false
    }
    if (
      where.NOT?.nowPlayingOverride !== undefined &&
      f.nowPlayingOverride === where.NOT.nowPlayingOverride
    ) {
      return false
    }
    if (where.OR) {
      const matches = where.OR.some((clause) => {
        if (
          clause.nowPlayingOverride !== undefined &&
          f.nowPlayingOverride === clause.nowPlayingOverride
        ) {
          return true
        }
        if (clause.nowPlaying === true && f.nowPlaying === true) return true
        return false
      })
      if (!matches) return false
    }
    if (where.sentimentGraph?.isNot === null && !f.sentimentGraph) return false
    return true
  })
}

function setup(films: FilmFixture[]) {
  mocks.prisma.film.findMany.mockImplementation(
    async (args: { where: WhereArg; take?: number }) => {
      const filtered = applyWhere(films, args.where)
      filtered.sort((a, b) => {
        const at = a.releaseDate ? a.releaseDate.getTime() : 0
        const bt = b.releaseDate ? b.releaseDate.getTime() : 0
        return bt - at
      })
      return filtered.slice(0, args.take ?? filtered.length)
    }
  )
}

describe('getInTheatersFilms gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('(a) excludes films with future releaseDate even when nowPlaying=true and sparkline present', async () => {
    setup([
      makeFilm({ id: 'future', releaseDate: FUTURE, nowPlaying: true }),
      makeFilm({ id: 'past', releaseDate: PAST, nowPlaying: true }),
    ])
    const result = await getInTheatersFilms()
    expect(result.map((f) => f.id)).toEqual(['past'])
  })

  it('(b) excludes films with null, empty, or missing sparkline dataPoints', async () => {
    setup([
      makeFilm({
        id: 'nullDp',
        nowPlaying: true,
        sentimentGraph: { overallScore: 7, dataPoints: null },
      }),
      makeFilm({
        id: 'emptyDp',
        nowPlaying: true,
        sentimentGraph: { overallScore: 7, dataPoints: [] },
      }),
      makeFilm({ id: 'noGraph', nowPlaying: true, sentimentGraph: null }),
      makeFilm({ id: 'ok', nowPlaying: true }),
    ])
    const result = await getInTheatersFilms()
    expect(result.map((f) => f.id)).toEqual(['ok'])
  })

  it('(c) INCLUDES force_show film when nowPlaying=false (past releaseDate, non-empty sparkline)', async () => {
    setup([
      makeFilm({
        id: 'forced',
        nowPlaying: false,
        nowPlayingOverride: 'force_show',
      }),
    ])
    const result = await getInTheatersFilms()
    expect(result.map((f) => f.id)).toEqual(['forced'])
  })

  it('(d) EXCLUDES force_show film with future releaseDate (force_show does not bypass release-date gate)', async () => {
    setup([
      makeFilm({
        id: 'forcedFuture',
        nowPlaying: false,
        nowPlayingOverride: 'force_show',
        releaseDate: FUTURE,
      }),
    ])
    const result = await getInTheatersFilms()
    expect(result).toEqual([])
  })

  it('(e) EXCLUDES force_show film with empty sparkline (force_show does not bypass sparkline gate)', async () => {
    setup([
      makeFilm({
        id: 'forcedEmpty',
        nowPlaying: false,
        nowPlayingOverride: 'force_show',
        sentimentGraph: { overallScore: 7, dataPoints: [] },
      }),
    ])
    const result = await getInTheatersFilms()
    expect(result).toEqual([])
  })

  it('(f) EXCLUDES force_hide regardless of nowPlaying / releaseDate / sparkline state', async () => {
    setup([
      makeFilm({
        id: 'hidden',
        nowPlaying: true,
        nowPlayingOverride: 'force_hide',
      }),
    ])
    const result = await getInTheatersFilms()
    expect(result).toEqual([])
  })

  it('caps final list at 20 even when many films qualify', async () => {
    const films = Array.from({ length: 30 }, (_, i) =>
      makeFilm({
        id: `f${i}`,
        nowPlaying: true,
        releaseDate: new Date(NOW.getTime() - (i + 1) * 86400000),
      })
    )
    setup(films)
    const result = await getInTheatersFilms()
    expect(result).toHaveLength(20)
    // Most recent releases first
    expect(result[0].id).toBe('f0')
  })
})
