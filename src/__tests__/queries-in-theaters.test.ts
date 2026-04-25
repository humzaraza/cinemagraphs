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
// PAST sits inside the 90-day recency window (60 days before NOW) so the
// canonical "released, in theaters" gating tests don't accidentally collide
// with the recency floor at 90 days.
const PAST = new Date(NOW.getTime() - 60 * 86400000)
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

// ── Where-clause simulator (faithful to Prisma 7 / SQL 3VL) ─────
// Reproduces the subset of Prisma where-semantics getInTheatersFilms
// uses, with one critical fidelity rule: NULL participates in
// three-valued logic. `NOT (col = 'X')` is UNKNOWN (not TRUE) when
// col IS NULL, so the WHERE clause rejects NULL rows. `{ not: 'X' }`
// behaves the same way. Inside an OR clause object, multiple fields
// AND together (Prisma's implicit AND).
type ScalarFilter<T> = T | { not?: T }
type WhereArg = {
  status?: 'ACTIVE' | 'ARCHIVED'
  releaseDate?: { not?: null; lte?: Date; gte?: Date }
  nowPlaying?: boolean
  nowPlayingOverride?: ScalarFilter<string | null>
  NOT?: WhereArg
  OR?: WhereArg[]
  AND?: WhereArg[]
  sentimentGraph?: { isNot?: null }
}

function isObjectFilter<T>(v: unknown): v is { not?: T } {
  return typeof v === 'object' && v !== null && 'not' in (v as object)
}

function matchesWhere(f: FilmFixture, where: WhereArg): boolean {
  if (where.status !== undefined && f.status !== where.status) return false

  if (where.releaseDate) {
    if (where.releaseDate.not === null && f.releaseDate === null) return false
    if (
      where.releaseDate.lte &&
      (f.releaseDate === null || f.releaseDate > where.releaseDate.lte)
    ) {
      return false
    }
    if (
      where.releaseDate.gte &&
      (f.releaseDate === null || f.releaseDate < where.releaseDate.gte)
    ) {
      return false
    }
  }

  if (where.nowPlaying !== undefined && f.nowPlaying !== where.nowPlaying) {
    return false
  }

  if (where.nowPlayingOverride !== undefined) {
    const filter = where.nowPlayingOverride
    if (isObjectFilter<string | null>(filter)) {
      // `{ not: 'X' }`: NULL rows fail (NULL <> 'X' is UNKNOWN).
      if (f.nowPlayingOverride === null) return false
      if (f.nowPlayingOverride === filter.not) return false
    } else {
      // Direct equality, including explicit `null`.
      if (f.nowPlayingOverride !== filter) return false
    }
  }

  if (where.sentimentGraph?.isNot === null && !f.sentimentGraph) return false

  if (where.NOT) {
    // For a NOT block, each subfilter inverts with 3-valued logic:
    // a NULL value on the field auto-fails (NOT UNKNOWN is UNKNOWN).
    if (where.NOT.nowPlayingOverride !== undefined) {
      const target = where.NOT.nowPlayingOverride
      if (f.nowPlayingOverride === null) return false
      if (
        !isObjectFilter<string | null>(target) &&
        f.nowPlayingOverride === target
      ) {
        return false
      }
    }
    if (where.NOT.nowPlaying !== undefined && f.nowPlaying === where.NOT.nowPlaying) {
      return false
    }
  }

  if (where.OR) {
    // Each clause is a sub-where; multiple fields inside a clause AND.
    const anyMatch = where.OR.some((clause) => matchesWhere(f, clause))
    if (!anyMatch) return false
  }

  if (where.AND) {
    const allMatch = where.AND.every((clause) => matchesWhere(f, clause))
    if (!allMatch) return false
  }

  return true
}

function applyWhere(films: FilmFixture[], where: WhereArg): FilmFixture[] {
  return films.filter((f) => matchesWhere(f, where))
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

  it('(g) INCLUDES the canonical case: nowPlaying=true + past release + null override + non-empty sparkline (regression for NOT-on-NULL bug)', async () => {
    setup([
      makeFilm({
        id: 'canonical',
        nowPlaying: true,
        nowPlayingOverride: null,
        releaseDate: PAST,
        sentimentGraph: { overallScore: 7.2, dataPoints: [{ score: 7.2 }] },
      }),
    ])
    const result = await getInTheatersFilms()
    expect(result.map((f) => f.id)).toEqual(['canonical'])
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

  // ── Recency gate (90-day floor): keeps anniversary re-releases out ──
  // Even when TMDB's /movie/now_playing surfaces them, films whose stored
  // releaseDate is the *original* theatrical release from months/years back
  // should be excluded. Boundary is inclusive at exactly 90 days.

  it('(h) excludes a film whose releaseDate is 6 months ago even when nowPlaying=true and sparkline non-empty', async () => {
    setup([
      makeFilm({
        id: 'oldRerelease',
        nowPlaying: true,
        releaseDate: new Date(NOW.getTime() - 180 * 86400000),
      }),
    ])
    const result = await getInTheatersFilms()
    expect(result).toEqual([])
  })

  it('(i) includes a film whose releaseDate is 30 days ago when nowPlaying=true and sparkline non-empty', async () => {
    setup([
      makeFilm({
        id: 'recent',
        nowPlaying: true,
        releaseDate: new Date(NOW.getTime() - 30 * 86400000),
      }),
    ])
    const result = await getInTheatersFilms()
    expect(result.map((f) => f.id)).toEqual(['recent'])
  })

  it('(j) recency boundary: 89 days ago is INCLUDED', async () => {
    setup([
      makeFilm({
        id: 'edgeIn',
        nowPlaying: true,
        releaseDate: new Date(NOW.getTime() - 89 * 86400000),
      }),
    ])
    const result = await getInTheatersFilms()
    expect(result.map((f) => f.id)).toEqual(['edgeIn'])
  })

  it('(k) recency boundary: 91 days ago is EXCLUDED', async () => {
    setup([
      makeFilm({
        id: 'edgeOut',
        nowPlaying: true,
        releaseDate: new Date(NOW.getTime() - 91 * 86400000),
      }),
    ])
    const result = await getInTheatersFilms()
    expect(result).toEqual([])
  })
})
