import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// The relevance ranking lives entirely in the SQL ORDER BY executed by Postgres,
// so these tests do NOT hit a real database. We mock prisma.$queryRaw and verify
// two things the route is responsible for:
//   1. the PRIMARY query asks Postgres to rank exact/prefix title matches first
//      (the tiered CASE sits ahead of ts_rank_cd in the ORDER BY), and
//   2. the route returns rows in the exact order the database ranked them, with
//      no client-side reordering that could undo that ranking.
const mocks = vi.hoisted(() => ({
  prisma: { $queryRaw: vi.fn() },
  apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/films/search${query}`)
}

// Minimal SearchRow-shaped record. Only the fields the route maps/returns matter;
// graphOverallScore is stripped into sentimentGraph and releaseDate drives `year`.
function row(id: string, title: string, graphOverallScore: number | null = null) {
  return { id, title, releaseDate: null, graphOverallScore }
}

// $queryRaw is a tagged template; the mock receives the template-strings array as
// its first argument. Join the static chunks to inspect the SQL skeleton.
function lastSql(callIndex = 0): string {
  const strings = mocks.prisma.$queryRaw.mock.calls[callIndex][0] as string[]
  return strings.join('?')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prisma.$queryRaw.mockResolvedValue([])
})

describe('GET /api/films/search relevance ranking', () => {
  it('ranks exact then prefix title matches ahead of ts_rank_cd in the primary query', async () => {
    // Non-empty primary result so the route does not fall through to the trigram fallback.
    mocks.prisma.$queryRaw.mockResolvedValueOnce([row('exact', 'Boy', 7.3)])
    const { GET } = await import('@/app/api/films/search/route')
    await GET(getRequest('?q=Boy'))

    expect(mocks.prisma.$queryRaw).toHaveBeenCalledTimes(1)
    const sql = lastSql()

    // The tiered title-match boost is present.
    expect(sql).toContain('ORDER BY')
    expect(sql).toContain('CASE')
    expect(sql).toContain('lower(f."title") = lower(') // exact tier (tier 0)
    expect(sql).toContain('LIKE') // prefix tier (tier 1)
    expect(sql).toContain("ESCAPE '!'") // prefix tier escapes LIKE wildcards

    // It outranks the existing keys: the CASE comes before ts_rank_cd, which
    // comes before the alphabetical title tiebreaker.
    expect(sql.indexOf('CASE')).toBeLessThan(sql.indexOf('ts_rank_cd'))
    expect(sql.indexOf('ts_rank_cd')).toBeLessThan(sql.lastIndexOf('f."title" ASC'))
  })

  it('does not alter the FTS WHERE clause (CASE only reorders matched rows)', async () => {
    mocks.prisma.$queryRaw.mockResolvedValueOnce([row('exact', 'Boy', 7.3)])
    const { GET } = await import('@/app/api/films/search/route')
    await GET(getRequest('?q=Boy'))
    const sql = lastSql()
    expect(sql).toContain(`f."status" = 'ACTIVE'`)
    expect(sql).toContain('f."searchVector" @@ websearch_to_tsquery')
  })

  it('returns films in the database ranking order, exact title first', async () => {
    // The DB (with the new ORDER BY) returns the exact-title film first even
    // though longer containing-titles have higher popularity scores. The route
    // must preserve that order and not re-sort.
    mocks.prisma.$queryRaw.mockResolvedValueOnce([
      row('exact', 'Boy', 7.3),
      row('long1', 'About a Boy', 9),
      row('long2', 'Boyhood', 8),
    ])
    const { GET } = await import('@/app/api/films/search/route')
    const res = await GET(getRequest('?q=Boy'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.films.map((f: { title: string }) => f.title)).toEqual([
      'Boy',
      'About a Boy',
      'Boyhood',
    ])
    expect(body.films[0].title).toBe('Boy')
  })

  it('does not run the trigram fallback when the primary FTS query returns rows', async () => {
    mocks.prisma.$queryRaw.mockResolvedValueOnce([row('exact', 'Boy', 7.3)])
    const { GET } = await import('@/app/api/films/search/route')
    await GET(getRequest('?q=Boy'))
    expect(mocks.prisma.$queryRaw).toHaveBeenCalledTimes(1)
  })
})
