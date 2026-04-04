import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before imports
const mockGetMovieCredits = vi.fn()
const mockPersonUpsert = vi.fn()
const mockPersonFindUnique = vi.fn()
const mockFilmPersonCreate = vi.fn()
const mockCacheDel = vi.fn()

vi.mock('@/lib/tmdb', () => ({
  getMovieCredits: (...args: unknown[]) => mockGetMovieCredits(...args),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    person: {
      upsert: (...args: unknown[]) => mockPersonUpsert(...args),
      findUnique: (...args: unknown[]) => mockPersonFindUnique(...args),
    },
    filmPerson: {
      create: (...args: unknown[]) => mockFilmPersonCreate(...args),
    },
  },
}))

vi.mock('@/lib/cache', () => ({
  cacheDel: (...args: unknown[]) => mockCacheDel(...args),
  KEYS: {
    person: (id: number) => `person:${id}`,
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  },
}))

import { syncFilmCredits } from '@/lib/person-sync'

beforeEach(() => {
  vi.clearAllMocks()
  // Default: person upsert succeeds, findUnique returns an id
  mockPersonUpsert.mockResolvedValue({})
  mockPersonFindUnique.mockImplementation((args: any) => {
    const tmdbId = args?.where?.tmdbPersonId
    return Promise.resolve(tmdbId ? { id: `person-${tmdbId}` } : null)
  })
  mockFilmPersonCreate.mockResolvedValue({})
  mockCacheDel.mockResolvedValue(undefined)
})

describe('syncFilmCredits', () => {
  it('creates Person and FilmPerson records from credits data', async () => {
    mockGetMovieCredits.mockResolvedValue({
      cast: [
        { id: 101, name: 'Actor One', character: 'Hero', order: 0, profile_path: '/a1.jpg', known_for_department: 'Acting' },
        { id: 102, name: 'Actor Two', character: 'Villain', order: 1, profile_path: '/a2.jpg', known_for_department: 'Acting' },
        { id: 103, name: 'Actor Three', character: 'Sidekick', order: 2, profile_path: null, known_for_department: 'Acting' },
      ],
      crew: [
        { id: 201, name: 'Director One', job: 'Director', profile_path: '/d1.jpg', known_for_department: 'Directing' },
        { id: 301, name: 'DP Person', job: 'Director of Photography', profile_path: '/dp.jpg', known_for_department: 'Camera' },
      ],
    })

    await syncFilmCredits('film-1', 12345)

    // 5 unique persons: 3 actors + 1 director + 1 cinematographer
    expect(mockPersonUpsert).toHaveBeenCalledTimes(5)
    expect(mockFilmPersonCreate).toHaveBeenCalledTimes(5)

    // Verify director role
    const directorCall = mockFilmPersonCreate.mock.calls.find(
      (call: any) => call[0].data.role === 'DIRECTOR',
    )
    expect(directorCall).toBeDefined()
    expect(directorCall![0].data.personId).toBe('person-201')

    // Verify actor roles have character names
    const actorCalls = mockFilmPersonCreate.mock.calls.filter(
      (call: any) => call[0].data.role === 'ACTOR',
    )
    expect(actorCalls).toHaveLength(3)
    expect(actorCalls[0][0].data.character).toBe('Hero')

    // Verify cinematographer
    const dpCall = mockFilmPersonCreate.mock.calls.find(
      (call: any) => call[0].data.role === 'CINEMATOGRAPHER',
    )
    expect(dpCall).toBeDefined()
  })

  it('filters crew roles correctly — ignores unrecognized jobs', async () => {
    mockGetMovieCredits.mockResolvedValue({
      cast: [],
      crew: [
        { id: 1, name: 'The Director', job: 'Director', profile_path: null },
        { id: 2, name: 'The DP', job: 'Director of Photography', profile_path: null },
        { id: 3, name: 'The Caterer', job: 'Caterer', profile_path: null },
        { id: 4, name: 'The Costumer', job: 'Costume Designer', profile_path: null },
        { id: 5, name: 'The Producer', job: 'Producer', profile_path: null },
        { id: 6, name: 'The Composer', job: 'Original Music Composer', profile_path: null },
        { id: 7, name: 'The Editor', job: 'Editor', profile_path: null },
        { id: 8, name: 'The Writer', job: 'Screenplay', profile_path: null },
        { id: 9, name: 'The Grip', job: 'Best Boy Grip', profile_path: null },
      ],
    })

    await syncFilmCredits('film-2', 99999)

    // Should process: Director, DP, Producer, Composer, Editor, Screenplay = 6
    // Should ignore: Caterer, Costume Designer, Best Boy Grip
    expect(mockPersonUpsert).toHaveBeenCalledTimes(6)
    expect(mockFilmPersonCreate).toHaveBeenCalledTimes(6)
  })

  it('handles TMDB API failure gracefully without throwing', async () => {
    mockGetMovieCredits.mockRejectedValue(new Error('TMDB rate limit exceeded'))

    // Should not throw
    await expect(syncFilmCredits('film-3', 77777)).resolves.toBeUndefined()

    // No records should be created
    expect(mockPersonUpsert).not.toHaveBeenCalled()
    expect(mockFilmPersonCreate).not.toHaveBeenCalled()
  })

  it('deduplicates same person with multiple roles', async () => {
    // Christopher Nolan as both director and writer
    mockGetMovieCredits.mockResolvedValue({
      cast: [],
      crew: [
        { id: 525, name: 'Christopher Nolan', job: 'Director', profile_path: '/cn.jpg' },
        { id: 525, name: 'Christopher Nolan', job: 'Screenplay', profile_path: '/cn.jpg' },
      ],
    })

    await syncFilmCredits('film-4', 55555)

    // Person upsert called twice (once per unique tmdbPersonId-role combo)
    // but same tmdbPersonId
    expect(mockPersonUpsert).toHaveBeenCalledTimes(2)

    // Both upserts should target the same tmdbPersonId
    const upsertTmdbIds = mockPersonUpsert.mock.calls.map((c: any) => c[0].where.tmdbPersonId)
    expect(upsertTmdbIds).toEqual([525, 525])

    // 2 FilmPerson records: DIRECTOR and WRITER
    expect(mockFilmPersonCreate).toHaveBeenCalledTimes(2)
    const roles = mockFilmPersonCreate.mock.calls.map((c: any) => c[0].data.role)
    expect(roles).toContain('DIRECTOR')
    expect(roles).toContain('WRITER')
  })

  it('deduplicates same person-role combo (e.g. listed twice as Producer)', async () => {
    mockGetMovieCredits.mockResolvedValue({
      cast: [],
      crew: [
        { id: 100, name: 'Double Producer', job: 'Producer', profile_path: null },
        { id: 100, name: 'Double Producer', job: 'Executive Producer', profile_path: null },
      ],
    })

    await syncFilmCredits('film-5', 44444)

    // Both map to PRODUCER role, same tmdbPersonId — deduplicated to 1
    expect(mockPersonUpsert).toHaveBeenCalledTimes(1)
    expect(mockFilmPersonCreate).toHaveBeenCalledTimes(1)
  })

  it('invalidates person cache for affected persons', async () => {
    mockGetMovieCredits.mockResolvedValue({
      cast: [
        { id: 501, name: 'Cached Actor', character: 'Role', order: 0, profile_path: null },
      ],
      crew: [
        { id: 502, name: 'Cached Director', job: 'Director', profile_path: null },
      ],
    })

    await syncFilmCredits('film-6', 33333)

    expect(mockCacheDel).toHaveBeenCalledTimes(1)
    const cacheKeys = mockCacheDel.mock.calls[0]
    expect(cacheKeys).toContain('person:501')
    expect(cacheKeys).toContain('person:502')
  })

  it('skips FilmPerson creation silently on unique constraint violation', async () => {
    mockGetMovieCredits.mockResolvedValue({
      cast: [
        { id: 601, name: 'Existing Actor', character: 'Role', order: 0, profile_path: null },
      ],
      crew: [],
    })

    // Simulate P2002 unique constraint violation on filmPerson create
    mockFilmPersonCreate.mockRejectedValue({ code: 'P2002' })

    // Should not throw
    await expect(syncFilmCredits('film-7', 22222)).resolves.toBeUndefined()
    expect(mockFilmPersonCreate).toHaveBeenCalledTimes(1)
  })
})
