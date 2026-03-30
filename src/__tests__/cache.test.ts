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

  it('deletes both film and graph keys', async () => {
    mockDel.mockResolvedValue(2)
    await invalidateFilmCache('abc-123')
    expect(mockDel).toHaveBeenCalledWith('film:abc-123', 'graph:abc-123')
  })
})
