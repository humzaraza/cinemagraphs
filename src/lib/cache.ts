import { kv } from '@vercel/kv'

const KV_AVAILABLE = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)

const DEFAULT_TTL = 3600 // 1 hour in seconds

// Key prefixes
const KEYS = {
  film: (id: string) => `film:${id}`,
  graph: (id: string) => `graph:${id}`,
  homepage: (section: string) => `homepage:${section}`,
} as const

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!KV_AVAILABLE) return null
  try {
    return await kv.get<T>(key)
  } catch {
    return null
  }
}

export async function cacheSet<T>(key: string, value: T, ttl = DEFAULT_TTL): Promise<void> {
  if (!KV_AVAILABLE) return
  try {
    await kv.set(key, value, { ex: ttl })
  } catch {
    // Silently fail — DB is the source of truth
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (!KV_AVAILABLE || keys.length === 0) return
  try {
    await kv.del(...keys)
  } catch {
    // Silently fail
  }
}

/** Invalidate all cached data for a specific film */
export async function invalidateFilmCache(filmId: string): Promise<void> {
  await cacheDel(KEYS.film(filmId), KEYS.graph(filmId))
}

/** Invalidate all homepage section caches */
export async function invalidateHomepageCache(): Promise<void> {
  await cacheDel(
    KEYS.homepage('topRated'),
    KEYS.homepage('biggestSwings'),
    KEYS.homepage('inTheaters'),
    KEYS.homepage('featured'),
    KEYS.homepage('ticker'),
    KEYS.homepage('sections'),
  )
}

export { KEYS }
