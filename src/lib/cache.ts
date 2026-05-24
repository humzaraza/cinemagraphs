import { redis, REDIS_AVAILABLE } from './redis'
import { logger } from './logger'

const cacheLogger = logger.child({ module: 'cache' })

// ── TTL constants (seconds) ──
export const TTL = {
  FILM: 3600,           // 1 hour
  FILMS_LIST: 120,      // 2 minutes (browse list reads)
  FILM_DETAIL: 120,     // 2 minutes (detail-page public reads)
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
  filmSimilar: (id: string) => `film:${id}:similar`,
  // Detail-page public reads, cached per film id. Kept separate from the
  // `film` / `filmSimilar` keys above (used by the /api/films/[id] route)
  // because the detail page reads different shapes (filmPersons, page-1
  // reviews, audience aggregates, the JSON-LD review set).
  filmDetailCore: (id: string) => `film:${id}:detail:core`,
  filmDetailReviews: (id: string) => `film:${id}:detail:reviews`,
  filmDetailAudience: (id: string) => `film:${id}:detail:audience`,
  filmDetailJsonLd: (id: string) => `film:${id}:detail:jsonld`,
  filmDetailSimilar: (id: string) => `film:${id}:detail:similar`,
  // TMDB trailer-key lookup result for a film. Public, detail-page only,
  // and the TMDB result rarely changes. Kept under the same
  // `film:<id>:detail:` namespace so invalidateFilmCache clears it too.
  filmTrailerKey: (id: string) => `film:${id}:detail:trailer`,
  graph: (id: string) => `graph:${id}`,
  homepage: (section: string) => `homepage:${section}`,
  ticker: () => 'ticker:data',
  tmdbNowPlaying: (region: string) => `tmdb:now_playing:${region}`,
  tmdbImages: (tmdbId: number, lang?: string) =>
    lang ? `tmdb:images:${tmdbId}:${lang}` : `tmdb:images:${tmdbId}`,
  // Filtered/sorted/capped backdrops for the banner picker, keyed by
  // internal Cinemagraphs filmId so we can invalidate by our own id.
  tmdbBackdrops: (filmId: string) => `tmdb:backdrops:${filmId}`,
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
//
// Negative caching: a fetchFn returning `null` is represented in Redis by a
// string sentinel rather than by JSON `null`. Without this, cacheGet cannot
// tell "key holds null" apart from "key absent" (Redis GET returns the same
// response either way), so every null result would re-run fetchFn on the next
// view. The sentinel is a string (not an object) so it survives the Redis
// JSON round-trip and compares by value; a reference-typed sentinel would
// fail the equality check after a hit and silently regress the fix.
// The literal cannot collide with any current caller's return: trailer keys
// (the only fetchFn that returns a string) are short alphanumeric YouTube ids
// and cannot contain `::`. The `::v1__` suffix lets us bump the sentinel if
// the convention ever has to change.
const CACHED_NULL_SENTINEL = '__cachedQuery::NULL::v1__'

export async function cachedQuery<T>(
  key: string,
  ttlSeconds: number,
  fetchFn: () => Promise<T>,
): Promise<T> {
  // Try cache first. The stored value is either the original T, the sentinel
  // (when the previous fetchFn returned null), or null (key absent).
  const cached = await cacheGet<T | string>(key)
  if (cached === CACHED_NULL_SENTINEL) return null as T  // genuine HIT, value is null
  if (cached !== null) return cached as T                // genuine HIT, non-null

  // True miss (key absent in Redis, or Redis down). Run fetchFn.
  const result = await fetchFn()

  // Store in cache (fire-and-forget). A null result becomes the sentinel so
  // the next read is a HIT, not another MISS.
  const toStore = result === null ? CACHED_NULL_SENTINEL : result
  cacheSet(key, toStore, ttlSeconds).catch(() => {})

  return result
}

// ── Invalidation helpers ──

/**
 * Invalidate all cached data for a specific film: the /api/films/[id]
 * route's `film` / `filmSimilar` / `graph` entries plus every detail-page
 * public key. Callers (admin sentiment regeneration, admin film edits,
 * the reviews POST handler, cron jobs) therefore refresh the detail page
 * immediately rather than waiting for the TTL.
 */
export async function invalidateFilmCache(filmId: string): Promise<void> {
  await cacheDel(
    KEYS.film(filmId),
    KEYS.filmSimilar(filmId),
    KEYS.graph(filmId),
    KEYS.filmDetailCore(filmId),
    KEYS.filmDetailReviews(filmId),
    KEYS.filmDetailAudience(filmId),
    KEYS.filmDetailJsonLd(filmId),
    KEYS.filmDetailSimilar(filmId),
    KEYS.filmTrailerKey(filmId),
  )
  cacheLogger.info({ filmId }, 'invalidated film cache')
}

/**
 * Invalidate ONLY the precomputed similar-films cache for a film. Used by the
 * bidirectional per-import recompute so neighbors don't pay an unrelated
 * `film:${id}` / `graph:${id}` cache miss.
 */
export async function invalidateFilmSimilarCache(filmId: string): Promise<void> {
  await cacheDel(KEYS.filmSimilar(filmId))
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
