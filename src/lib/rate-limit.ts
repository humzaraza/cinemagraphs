/**
 * Sliding window rate limiter backed by Redis (Upstash).
 *
 * Falls back to an in-memory implementation when Redis is unavailable
 * (no env vars set, or transient pipeline error). The in-memory path
 * resets on every Vercel serverless cold start and never shares state
 * across instances; treat it as a development convenience, not as
 * production protection.
 */

import { redis, REDIS_AVAILABLE } from './redis'

export interface RateLimitResult {
  limited: boolean
  remaining: number
  retryAfterMs: number
}

interface InMemoryEntry {
  timestamps: number[]
}

const stores = new Map<string, Map<string, InMemoryEntry>>()

function getStore(name: string): Map<string, InMemoryEntry> {
  if (!stores.has(name)) {
    stores.set(name, new Map())
  }
  return stores.get(name)!
}

function checkInMemory(
  namespace: string,
  identifier: string,
  maxRequests: number,
  windowMs: number,
): RateLimitResult {
  const store = getStore(namespace)
  const now = Date.now()
  const windowStart = now - windowMs

  let entry = store.get(identifier)
  if (!entry) {
    entry = { timestamps: [] }
    store.set(identifier, entry)
  }

  entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

  if (entry.timestamps.length >= maxRequests) {
    const oldest = entry.timestamps[0]
    return { limited: true, remaining: 0, retryAfterMs: oldest + windowMs - now }
  }

  entry.timestamps.push(now)
  return {
    limited: false,
    remaining: maxRequests - entry.timestamps.length,
    retryAfterMs: 0,
  }
}

// Periodically clean up stale in-memory entries (every 5 minutes).
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [, store] of stores) {
      for (const [key, entry] of store) {
        if (entry.timestamps.every((t) => t < now - 3_600_000)) {
          store.delete(key)
        }
      }
    }
  }, 300_000)
}

/**
 * Check whether the (namespace, identifier) pair has exceeded
 * `maxRequests` in the trailing `windowMs` window. Records the
 * current attempt as a side effect when not limited.
 *
 * Uses Redis sorted sets when available: ZREMRANGEBYSCORE prunes
 * out-of-window entries, ZADD records the current attempt, ZCARD
 * returns the post-add count. All four commands run in a single
 * pipeline for one round trip. PEXPIRE keeps unused keys from
 * accumulating.
 */
export async function checkRateLimit(
  namespace: string,
  identifier: string,
  maxRequests: number,
  windowMs: number,
): Promise<RateLimitResult> {
  if (!REDIS_AVAILABLE || !redis) {
    return checkInMemory(namespace, identifier, maxRequests, windowMs)
  }

  const key = `rl:${namespace}:${identifier}`
  const now = Date.now()
  const windowStart = now - windowMs
  // Member is timestamp + random suffix so two ZADDs in the same
  // millisecond don't collide on the sorted-set member key.
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`

  try {
    const pipeline = redis.pipeline()
    pipeline.zremrangebyscore(key, 0, windowStart)
    pipeline.zadd(key, { score: now, member })
    pipeline.zcard(key)
    pipeline.pexpire(key, windowMs)
    const results = (await pipeline.exec()) as unknown[]

    // Pipeline result order matches command order. ZCARD is index 2.
    const count = Number(results[2] ?? 0)

    if (count > maxRequests) {
      // Fetch the oldest entry's score to compute retry-after.
      const oldest = (await redis.zrange(key, 0, 0, { withScores: true })) as unknown[]
      const oldestScore = oldest && oldest.length >= 2 ? Number(oldest[1]) : now
      const retryAfterMs = Math.max(0, oldestScore + windowMs - now)
      return { limited: true, remaining: 0, retryAfterMs }
    }

    return {
      limited: false,
      remaining: Math.max(0, maxRequests - count),
      retryAfterMs: 0,
    }
  } catch {
    // Redis transient error: never fail open. Use in-memory as fallback.
    return checkInMemory(namespace, identifier, maxRequests, windowMs)
  }
}
