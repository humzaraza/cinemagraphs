import { redis, REDIS_AVAILABLE } from './redis'
import { logger } from './logger'

const cacheLogger = logger.child({ module: 'cache' })

// ── TTL constants (seconds) ──
export const TTL = {
  FILM: 3600,           // 1 hour
  GRAPH: 3600,          // 1 hour
  HOMEPAGE: 3600,       // 1 hour
  TICKER: 1800,         // 30 minutes
  TMDB_NOW_PLAYING: 21600, // 6 hours
  TMDB_IMAGES: 604800,  // 7 days
  OMDB: 86400,          // 24 hours
  PERSON: 3600,         // 1 hour
} as const

// ── Key builders ──
export const KEYS = {
  film: (id: string) => `film:${id}`,
  graph: (id: string) => `graph:${id}`,
  homepage: (section: string) => `homepage:${section}`,
  ticker: () => 'ticker:data',
  tmdbNowPlaying: (region: string) => `tmdb:now_playing:${region}`,
  tmdbImages: (tmdbId: number, lang?: string) =>
    lang ? `tmdb:images:${tmdbId}:${lang}` : `tmdb:images:${tmdbId}`,
  omdb: (imdbId: string) => `omdb:${imdbId}`,
  person: (tmdbPersonId: number) => `person:${tmdbPersonId}`,
} as const

// ── Low-level get/set/del ──

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!REDIS_AVAILABLE || !redis) return null
  try {
    const value = await redis.get<T>(key)
    if (value !== null && value !== undefined) {
      cacheLogger.debug({ key }, 'cache HIT')
    } else {
      cacheLogger.debug({ key }, 'cache MISS')
    }
    return value ?? null
  } catch (err) {
    cacheLogger.warn({ key, err }, 'cache GET failed, falling back to source')
    return null
  }
}

export async function cacheSet<T>(key: string, value: T, ttl: number = TTL.FILM): Promise<void> {
  if (!REDIS_AVAILABLE || !redis) return
  try {
    await redis.set(key, value, { ex: ttl })
    cacheLogger.debug({ key, ttl }, 'cache SET')
  } catch (err) {
    cacheLogger.warn({ key, err }, 'cache SET failed')
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (!REDIS_AVAILABLE || !redis || keys.length === 0) return
  try {
    await redis.del(...keys)
    cacheLogger.debug({ keys }, 'cache DEL')
  } catch (err) {
    cacheLogger.warn({ keys, err }, 'cache DEL failed')
  }
}

// ── cachedQuery wrapper ──
// Checks Redis first, falls back to fetchFn, stores result.
// Never lets a Redis failure break the site.

export async function cachedQuery<T>(
  key: string,
  ttlSeconds: number,
  fetchFn: () => Promise<T>,
): Promise<T> {
  // Try cache first
  const cached = await cacheGet<T>(key)
  if (cached !== null) return cached

  // Cache miss or Redis down -- run the fetch function
  const result = await fetchFn()

  // Store in cache (fire-and-forget, don't block on it)
  cacheSet(key, result, ttlSeconds).catch(() => {})

  return result
}

// ── Invalidation helpers ──

/** Invalidate all cached data for a specific film */
export async function invalidateFilmCache(filmId: string): Promise<void> {
  await cacheDel(KEYS.film(filmId), KEYS.graph(filmId))
  cacheLogger.info({ filmId }, 'invalidated film cache')
}

/** Invalidate all homepage section caches */
export async function invalidateHomepageCache(): Promise<void> {
  await cacheDel(
    KEYS.homepage('topRated'),
    KEYS.homepage('biggestSwings'),
    KEYS.homepage('inTheaters'),
    KEYS.homepage('featured'),
    KEYS.homepage('sections'),
    KEYS.homepage('data'),
    KEYS.ticker(),
  )
  cacheLogger.info('invalidated homepage cache')
}

/** Invalidate ticker data specifically */
export async function invalidateTickerCache(): Promise<void> {
  await cacheDel(KEYS.ticker())
}

/** Invalidate TMDB now_playing cache */
export async function invalidateTmdbNowPlaying(region: string = 'CA'): Promise<void> {
  await cacheDel(KEYS.tmdbNowPlaying(region))
}
