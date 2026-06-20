import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted above the import of the module under test) ──

// In-memory Redis that JSON-round-trips values exactly like Upstash: objects
// are serialized on set and parsed on get, so a Date stored on a miss comes
// back as a string on a hit. This is what reproduces the cache-HIT Date bug
// class deterministically.
const { redisStore, fakeRedis, mockFindUnique } = vi.hoisted(() => {
  const redisStore = new Map<string, string>()
  const fakeRedis = {
    get: async (key: string) => {
      const raw = redisStore.get(key)
      return raw === undefined ? null : JSON.parse(raw)
    },
    set: async (key: string, value: unknown) => {
      redisStore.set(key, JSON.stringify(value))
      return 'OK'
    },
    del: async (...keys: string[]) => {
      keys.forEach((k) => redisStore.delete(k))
      return keys.length
    },
  }
  return { redisStore, fakeRedis, mockFindUnique: vi.fn() }
})

vi.mock('@/lib/redis', () => ({ redis: fakeRedis, REDIS_AVAILABLE: true }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    person: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: vi.fn(),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}))

// React cache() must be identity here: with the real per-request memoization,
// the second getPersonData() call would return the first call's memoized
// promise and never re-enter cachedQuery, so the cache-HIT path would not be
// exercised at all. Identity forces both calls through cachedQuery.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, cache: (fn: unknown) => fn }
})

// after() must not run its callback (it would fire syncPersonBio -> TMDB).
vi.mock('next/server', () => ({ after: vi.fn() }))

import { getPersonData } from '@/lib/person-data'

// A person as Prisma would return it: relation included, releaseDate a real
// Date, three directed films so the composite arc is computed.
function buildPersonFixture() {
  const dataPoints = [
    { percent: 0, score: 7 },
    { percent: 50, score: 6 },
    { percent: 100, score: 8 },
  ]
  const film = (id: string, title: string, iso: string) => ({
    role: 'DIRECTOR',
    character: null,
    film: {
      id,
      title,
      posterUrl: `/${id}.jpg`,
      releaseDate: new Date(iso),
      runtime: 110,
      sentimentGraph: { overallScore: 7.5, dataPoints },
    },
  })
  return {
    id: 'person-1',
    name: 'Greta Gerwig',
    slug: 'greta-gerwig-45400',
    tmdbPersonId: 45400,
    profilePath: '/profile.jpg',
    biography: 'An American filmmaker.', // non-null: no bio backfill scheduled
    birthday: '1983-08-04',
    deathday: null,
    knownForDepartment: 'Directing',
    bioFetchedAt: null,
    films: [
      film('film-barbie', 'Barbie', '2023-07-21'),
      film('film-ladybird', 'Lady Bird', '2017-11-03'),
      film('film-littlewomen', 'Little Women', '2019-12-25'),
    ],
  }
}

// ── Page date logic, mirrored from src/app/person/[slug]/page.tsx. These run
// over whatever shape the render receives, so they must tolerate the HIT value. ──
const byReleaseDesc = (a: { releaseDate: string | null }, b: { releaseDate: string | null }) => {
  const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0
  const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0
  return dateB - dateA
}
const formatBioDate = (dateStr: string | null) => {
  if (!dateStr) return null
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  } catch {
    return dateStr
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  redisStore.clear()
  mockFindUnique.mockResolvedValue(buildPersonFixture())
})

describe('getPersonData cache-HIT shape (Layer 1)', () => {
  it('serves the second read from cache and keeps releaseDate a string the render can consume', async () => {
    // First call: cache MISS -> fetchPersonData runs against Prisma, result stored.
    const miss = await getPersonData(45400)
    // Second call: cache HIT -> value comes back through the Redis JSON round-trip.
    const hit = await getPersonData(45400)

    // The second read must be a genuine cache hit: fetchPersonData (hence the
    // Prisma query) ran exactly once across both calls.
    expect(mockFindUnique).toHaveBeenCalledTimes(1)

    expect(miss).not.toBeNull()
    expect(hit).not.toBeNull()

    // The HIT value is JSON-safe: releaseDate is a string, not a Date object.
    expect(typeof hit!.filmography[0].releaseDate).toBe('string')
    expect(hit!.filmography[0].releaseDate).toMatch(/^2023-07-21/)

    // HIT deep-equals MISS (the derived shape survives the round-trip intact).
    expect(hit).toEqual(miss)

    // Filmography is date-descending and the composite arc survived the trip.
    expect(hit!.filmography.map((f) => f.title)).toEqual(['Barbie', 'Little Women', 'Lady Bird'])
    expect(hit!.compositeArc).not.toBeNull()
    expect(typeof hit!.compositeArc!.filmCount).toBe('number')
    expect(hit!.compositeArc!.filmCount).toBe(3)
    expect(Array.isArray(hit!.compositeArc!.arcPoints)).toBe(true)

    // The page's date logic does not throw over the HIT value (this is the
    // exact failure mode the old code hit on a cached Date-turned-string).
    expect(() => [...hit!.filmography].sort(byReleaseDesc)).not.toThrow()
    expect(() => formatBioDate(hit!.birthday)).not.toThrow()
    expect(typeof formatBioDate(hit!.birthday)).toBe('string')
  })
})

describe('OLD raw-Prisma caching would throw on a cache HIT (Layer 2, negative control)', () => {
  it('proves the removed `.toISOString()` render expression throws on a rehydrated releaseDate', () => {
    // The OLD design cached the raw Prisma object, so releaseDate was a Date.
    const rawPrismaEntry = { releaseDate: new Date('2023-07-21') }

    // A Redis hit = JSON round-trip, which turns the Date into a string.
    const rehydrated = JSON.parse(JSON.stringify(rawPrismaEntry)) as { releaseDate: string }
    expect(typeof rehydrated.releaseDate).toBe('string')

    // The OLD page expression was `fp.film.releaseDate?.toISOString()`. On the
    // rehydrated string this throws, which is the bug. This assertion failing
    // (i.e. NOT throwing) would mean the control is vacuous.
    expect(() => (rehydrated.releaseDate as unknown as Date).toISOString()).toThrow(TypeError)

    // Contrast: the NEW consumption (`new Date(string)`) handles the same
    // rehydrated string without throwing, which is why the fix works.
    expect(() => new Date(rehydrated.releaseDate).getTime()).not.toThrow()
  })
})
