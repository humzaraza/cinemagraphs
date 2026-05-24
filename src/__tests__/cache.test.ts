import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock calls are hoisted -- use vi.hoisted to create shared refs
const { mockGet, mockSet, mockDel } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockDel: vi.fn(),
}))

vi.mock('@/lib/redis', () => ({
  redis: { get: mockGet, set: mockSet, del: mockDel },
  REDIS_AVAILABLE: true,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

import { cachedQuery, cacheGet, cacheSet, cacheDel, invalidateFilmCache } from '@/lib/cache'

describe('cacheGet / cacheSet / cacheDel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns cached value on hit', async () => {
    mockGet.mockResolvedValue({ title: 'Inception' })
    const result = await cacheGet('film:123')
    expect(result).toEqual({ title: 'Inception' })
    expect(mockGet).toHaveBeenCalledWith('film:123')
  })

  it('returns null on cache miss', async () => {
    mockGet.mockResolvedValue(null)
    const result = await cacheGet('film:missing')
    expect(result).toBeNull()
  })

  it('returns null when Redis throws', async () => {
    mockGet.mockRejectedValue(new Error('connection refused'))
    const result = await cacheGet('film:err')
    expect(result).toBeNull()
  })

  it('sets value with TTL', async () => {
    mockSet.mockResolvedValue('OK')
    await cacheSet('film:123', { title: 'Inception' }, 3600)
    expect(mockSet).toHaveBeenCalledWith('film:123', { title: 'Inception' }, { ex: 3600 })
  })

  it('deletes keys', async () => {
    mockDel.mockResolvedValue(1)
    await cacheDel('film:123', 'graph:123')
    expect(mockDel).toHaveBeenCalledWith('film:123', 'graph:123')
  })
})

describe('cachedQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns cached value without calling fetchFn (cache hit)', async () => {
    mockGet.mockResolvedValue({ title: 'Cached Film' })
    const fetchFn = vi.fn()

    const result = await cachedQuery('film:1', 3600, fetchFn)

    expect(result).toEqual({ title: 'Cached Film' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('calls fetchFn and stores result on cache miss', async () => {
    mockGet.mockResolvedValue(null)
    mockSet.mockResolvedValue('OK')
    const fetchFn = vi.fn().mockResolvedValue({ title: 'Fresh Film' })

    const result = await cachedQuery('film:2', 3600, fetchFn)

    expect(result).toEqual({ title: 'Fresh Film' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // cacheSet is fire-and-forget, wait a tick
    await new Promise((r) => setTimeout(r, 10))
    expect(mockSet).toHaveBeenCalledWith('film:2', { title: 'Fresh Film' }, { ex: 3600 })
  })

  it('falls back to fetchFn when Redis fails on get', async () => {
    mockGet.mockRejectedValue(new Error('Redis down'))
    mockSet.mockResolvedValue('OK')
    const fetchFn = vi.fn().mockResolvedValue({ title: 'Fallback Film' })

    const result = await cachedQuery('film:3', 3600, fetchFn)

    expect(result).toEqual({ title: 'Fallback Film' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('still returns data when Redis fails on set after miss', async () => {
    mockGet.mockResolvedValue(null)
    mockSet.mockRejectedValue(new Error('Redis write failed'))
    const fetchFn = vi.fn().mockResolvedValue({ title: 'Data' })

    const result = await cachedQuery('film:4', 3600, fetchFn)

    expect(result).toEqual({ title: 'Data' })
  })

  it('propagates fetchFn errors (DB errors should not be silenced)', async () => {
    mockGet.mockResolvedValue(null)
    const fetchFn = vi.fn().mockRejectedValue(new Error('DB connection lost'))

    await expect(cachedQuery('film:5', 3600, fetchFn)).rejects.toThrow('DB connection lost')
  })
})

describe('invalidateFilmCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deletes the film, similar, graph and detail-page keys', async () => {
    mockDel.mockResolvedValue(9)
    await invalidateFilmCache('abc-123')
    expect(mockDel).toHaveBeenCalledWith(
      'film:abc-123',
      'film:abc-123:similar',
      'graph:abc-123',
      'film:abc-123:detail:core',
      'film:abc-123:detail:reviews',
      'film:abc-123:detail:audience',
      'film:abc-123:detail:jsonld',
      'film:abc-123:detail:similar',
      'film:abc-123:detail:trailer',
    )
  })
})

describe('cachedQuery — negative caching (null results)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Test 1 (the hole being closed): a fetchFn returning null is cached so
  // the second call skips fetchFn entirely.
  it('caches a null result and skips fetchFn on the second call', async () => {
    mockSet.mockResolvedValue('OK')

    // First call: true miss. fetchFn runs, returns null; the wrapper stores
    // a sentinel so the next read can distinguish "cached null" from
    // "key absent".
    mockGet.mockResolvedValueOnce(null)
    const fetchFn = vi.fn().mockResolvedValue(null)
    const r1 = await cachedQuery('k', 3600, fetchFn)
    expect(r1).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // cacheSet is fire-and-forget, wait a tick before reading what it stored.
    await new Promise((r) => setTimeout(r, 10))
    expect(mockSet).toHaveBeenCalledTimes(1)
    const storedSentinel = mockSet.mock.calls[0][1]
    // The wrapper must NOT have stored literal null (that's exactly the
    // ambiguity that defeated the cache on read).
    expect(storedSentinel).not.toBeNull()

    // Second call: cacheGet returns what Redis actually held (the sentinel).
    mockGet.mockResolvedValueOnce(storedSentinel)
    const r2 = await cachedQuery('k', 3600, fetchFn)
    expect(r2).toBeNull()
    // The hole is closed: fetchFn is not re-run.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  // Test 2 (true-miss path): cachedQuery returns a real null to the caller,
  // never the sentinel string.
  it('true-miss path: returns a real null to the caller, never the sentinel string', async () => {
    mockGet.mockResolvedValueOnce(null)
    mockSet.mockResolvedValue('OK')
    const result = await cachedQuery('k', 3600, vi.fn().mockResolvedValue(null))
    expect(result).toBeNull()
    expect(typeof result).not.toBe('string')
  })

  // Test 2 (cached-sentinel path): same assertion, second call.
  it('cached-sentinel path: returns a real null to the caller, never the sentinel string', async () => {
    mockSet.mockResolvedValue('OK')
    // Trigger one store so we can capture whatever sentinel the wrapper uses
    // (avoids hard-coding the literal string in the test, which would make
    // the test pass even if the implementation regressed to a different
    // sentinel that does collide with a real value).
    mockGet.mockResolvedValueOnce(null)
    await cachedQuery('k', 3600, vi.fn().mockResolvedValue(null))
    await new Promise((r) => setTimeout(r, 10))
    const sentinel = mockSet.mock.calls[0][1]

    // Simulate the cached-sentinel read on a fresh wrapper call.
    mockGet.mockResolvedValueOnce(sentinel)
    const fetchFn = vi.fn()
    const result = await cachedQuery('k', 3600, fetchFn)
    expect(result).toBeNull()
    expect(typeof result).not.toBe('string')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  // Test 3: an ordinary non-null value still caches and round-trips correctly.
  it('caches and round-trips a non-null object value', async () => {
    mockSet.mockResolvedValue('OK')
    mockGet.mockResolvedValueOnce(null)
    const fetchFn = vi.fn().mockResolvedValue({ title: 'Inception' })

    const r1 = await cachedQuery('k', 3600, fetchFn)
    expect(r1).toEqual({ title: 'Inception' })
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await new Promise((r) => setTimeout(r, 10))
    expect(mockSet).toHaveBeenCalledWith('k', { title: 'Inception' }, { ex: 3600 })

    mockGet.mockResolvedValueOnce({ title: 'Inception' })
    const r2 = await cachedQuery('k', 3600, fetchFn)
    expect(r2).toEqual({ title: 'Inception' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  // Test 4: non-null falsy values still cache and return correctly. The fix
  // must not have regressed the existing non-null handling.
  it('returns non-null falsy values from cache without re-running fetchFn (0, "", false, [], {})', async () => {
    const cases: { name: string; value: unknown }[] = [
      { name: 'zero', value: 0 },
      { name: 'empty string', value: '' },
      { name: 'false', value: false },
      { name: 'empty array', value: [] },
      { name: 'empty object', value: {} },
    ]
    for (const { name, value } of cases) {
      mockGet.mockResolvedValueOnce(value)
      const fetchFn = vi.fn()
      const result = await cachedQuery(`k:${name}`, 3600, fetchFn)
      expect(result, `for ${name}`).toEqual(value)
      expect(fetchFn, `for ${name}`).not.toHaveBeenCalled()
    }
  })

  // Test 5: an ordinary string caches and returns exactly, not mistaken for
  // the sentinel. Uses a YouTube-style trailer key (the only real string-
  // returning fetchFn).
  it('caches and returns an ordinary string, not mistaken for the sentinel', async () => {
    mockSet.mockResolvedValue('OK')
    mockGet.mockResolvedValueOnce(null)
    const fetchFn = vi.fn().mockResolvedValue('dQw4w9WgXcQ')

    const r1 = await cachedQuery('k', 3600, fetchFn)
    expect(r1).toBe('dQw4w9WgXcQ')

    await new Promise((r) => setTimeout(r, 10))
    expect(mockSet).toHaveBeenCalledWith('k', 'dQw4w9WgXcQ', { ex: 3600 })

    mockGet.mockResolvedValueOnce('dQw4w9WgXcQ')
    const r2 = await cachedQuery('k', 3600, fetchFn)
    expect(r2).toBe('dQw4w9WgXcQ')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  // Test 6: a genuine miss (cacheGet returns null because no key was ever
  // stored) still runs fetchFn.
  it('still runs fetchFn on a genuine miss (cacheGet returns null, nothing was ever stored)', async () => {
    mockSet.mockResolvedValue('OK')
    mockGet.mockResolvedValueOnce(null)
    const fetchFn = vi.fn().mockResolvedValue({ id: 'fresh' })

    const result = await cachedQuery('k', 3600, fetchFn)
    expect(result).toEqual({ id: 'fresh' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
