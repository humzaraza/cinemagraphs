import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// rate-limit.ts only invokes redis methods inside the exported function (not
// at module load), so the mock factory closures resolve lazily and we don't
// need vi.hoisted for the redis instance itself. We DO use vi.hoisted for the
// individual mock fns so they're available to the factory if anything ever
// changes to call redis at module-load time, matching the chunk template.
const {
  mockPipelineExec,
  mockZrange,
  mockZremrangebyscore,
  mockZadd,
  mockZcard,
  mockPexpire,
} = vi.hoisted(() => ({
  mockPipelineExec: vi.fn(),
  mockZrange: vi.fn(),
  mockZremrangebyscore: vi.fn(),
  mockZadd: vi.fn(),
  mockZcard: vi.fn(),
  mockPexpire: vi.fn(),
}))

vi.mock('@/lib/redis', () => {
  const pipeline = {
    zremrangebyscore: (...args: unknown[]) => {
      mockZremrangebyscore(...args)
      return pipeline
    },
    zadd: (...args: unknown[]) => {
      mockZadd(...args)
      return pipeline
    },
    zcard: (...args: unknown[]) => {
      mockZcard(...args)
      return pipeline
    },
    pexpire: (...args: unknown[]) => {
      mockPexpire(...args)
      return pipeline
    },
    exec: mockPipelineExec,
  }
  return {
    redis: {
      pipeline: () => pipeline,
      zrange: mockZrange,
    },
    REDIS_AVAILABLE: true,
  }
})

import { checkRateLimit } from '@/lib/rate-limit'

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Redis-backed path (REDIS_AVAILABLE=true via the top-level vi.mock)
// ---------------------------------------------------------------------------
describe('checkRateLimit (Redis path)', () => {
  it('happy path: under limit returns limited:false', async () => {
    // pipeline.exec returns [zrem-count, zadd-count, zcard, pexpire-success]
    mockPipelineExec.mockResolvedValue([0, 1, 1, 1])

    const result = await checkRateLimit('ns', 'id-1', 10, 60_000)

    expect(result.limited).toBe(false)
    expect(result.retryAfterMs).toBe(0)
  })

  it('at limit: returns limited:true with non-zero retryAfterMs', async () => {
    const now = Date.now()
    // zcard returns 11; max is 10. Trigger limited path.
    mockPipelineExec.mockResolvedValue([0, 1, 11, 1])
    // Oldest entry is 1 second ago, window is 60s, so retryAfter ~= 59s.
    mockZrange.mockResolvedValue(['some-member', String(now - 1000)])

    const result = await checkRateLimit('ns', 'id-2', 10, 60_000)

    expect(result.limited).toBe(true)
    expect(result.retryAfterMs).toBeGreaterThan(0)
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000)
  })

  it('different namespaces use different Redis keys (no bleed)', async () => {
    mockPipelineExec.mockResolvedValue([0, 1, 1, 1])

    await checkRateLimit('mobile-login', 'ip-1', 10, 60_000)
    await checkRateLimit('register', 'ip-1', 10, 60_000)

    expect(mockZadd.mock.calls[0][0]).toBe('rl:mobile-login:ip-1')
    expect(mockZadd.mock.calls[1][0]).toBe('rl:register:ip-1')
  })

  it('different identifiers use different Redis keys (no bleed)', async () => {
    mockPipelineExec.mockResolvedValue([0, 1, 1, 1])

    await checkRateLimit('mobile-login', 'ip-1', 10, 60_000)
    await checkRateLimit('mobile-login', 'ip-2', 10, 60_000)

    expect(mockZadd.mock.calls[0][0]).toBe('rl:mobile-login:ip-1')
    expect(mockZadd.mock.calls[1][0]).toBe('rl:mobile-login:ip-2')
  })

  it('Redis error falls back to in-memory cleanly (does not throw)', async () => {
    mockPipelineExec.mockRejectedValue(new Error('upstash connection lost'))

    // Use a unique namespace+identifier so the in-memory store is empty.
    const result = await checkRateLimit('error-ns-unique', 'id-x', 10, 60_000)

    // Fallback succeeds with first-call-not-limited behavior.
    expect(result.limited).toBe(false)
    expect(result.retryAfterMs).toBe(0)
  })

  it('sets TTL on the rate-limit key via pexpire', async () => {
    mockPipelineExec.mockResolvedValue([0, 1, 1, 1])

    await checkRateLimit('ttl-ns', 'id-ttl', 10, 60_000)

    expect(mockPexpire).toHaveBeenCalledWith('rl:ttl-ns:id-ttl', 60_000)
  })
})

// ---------------------------------------------------------------------------
// In-memory fallback path (REDIS_AVAILABLE=false via vi.doMock + dynamic import)
// ---------------------------------------------------------------------------
describe('checkRateLimit (in-memory fallback)', () => {
  let inMemCheck: typeof checkRateLimit
  let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('@/lib/redis', () => ({
      redis: null,
      REDIS_AVAILABLE: false,
    }))
    const mod = await import('@/lib/rate-limit')
    inMemCheck = mod.checkRateLimit
  })

  afterEach(() => {
    if (dateNowSpy) {
      dateNowSpy.mockRestore()
      dateNowSpy = null
    }
    vi.doUnmock('@/lib/redis')
  })

  it('REDIS_AVAILABLE=false: in-memory allows up to maxRequests then blocks', async () => {
    // Limit of 3 in a 60s window. First 3 calls allowed, 4th blocked.
    const first = await inMemCheck('mem-ns', 'mem-id', 3, 60_000)
    const second = await inMemCheck('mem-ns', 'mem-id', 3, 60_000)
    const third = await inMemCheck('mem-ns', 'mem-id', 3, 60_000)
    const fourth = await inMemCheck('mem-ns', 'mem-id', 3, 60_000)

    expect(first.limited).toBe(false)
    expect(second.limited).toBe(false)
    expect(third.limited).toBe(false)
    expect(fourth.limited).toBe(true)
    expect(fourth.retryAfterMs).toBeGreaterThan(0)
  })

  it('sliding window: requests outside the window do not count toward the limit', async () => {
    // Pin time to t=1_000_000.
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

    // Two requests at t=1_000_000 with limit=2, window=1000ms.
    expect((await inMemCheck('sw', 'id-sw', 2, 1000)).limited).toBe(false)
    expect((await inMemCheck('sw', 'id-sw', 2, 1000)).limited).toBe(false)

    // Advance past the window: t = 1_000_000 + 1001 (= windowMs + 1).
    dateNowSpy.mockReturnValue(1_000_000 + 1001)

    // Third request: previous two are now outside the window; should pass.
    const third = await inMemCheck('sw', 'id-sw', 2, 1000)
    expect(third.limited).toBe(false)
  })
})
