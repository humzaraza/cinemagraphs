/**
 * Simple in-memory sliding window rate limiter.
 * Tracks request timestamps per key (IP) and rejects when limit is exceeded.
 * Note: resets on serverless cold starts — acceptable for basic bot protection.
 */

interface RateLimitEntry {
  timestamps: number[]
}

const stores = new Map<string, Map<string, RateLimitEntry>>()

function getStore(name: string): Map<string, RateLimitEntry> {
  if (!stores.has(name)) {
    stores.set(name, new Map())
  }
  return stores.get(name)!
}

/**
 * Check if a key (typically IP) has exceeded the rate limit.
 * @returns { limited: boolean, remaining: number, retryAfterMs: number }
 */
export function checkRateLimit(
  storeName: string,
  key: string,
  maxRequests: number,
  windowMs: number
): { limited: boolean; remaining: number; retryAfterMs: number } {
  const store = getStore(storeName)
  const now = Date.now()
  const windowStart = now - windowMs

  let entry = store.get(key)
  if (!entry) {
    entry = { timestamps: [] }
    store.set(key, entry)
  }

  // Remove timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

  if (entry.timestamps.length >= maxRequests) {
    const oldestInWindow = entry.timestamps[0]
    const retryAfterMs = oldestInWindow + windowMs - now
    return { limited: true, remaining: 0, retryAfterMs }
  }

  entry.timestamps.push(now)
  return {
    limited: false,
    remaining: maxRequests - entry.timestamps.length,
    retryAfterMs: 0,
  }
}

// Periodically clean up stale entries (every 5 minutes)
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [, store] of stores) {
      for (const [key, entry] of store) {
        // Remove entries with no recent timestamps (older than 1 hour)
        if (entry.timestamps.every((t) => t < now - 3600_000)) {
          store.delete(key)
        }
      }
    }
  }, 300_000)
}
