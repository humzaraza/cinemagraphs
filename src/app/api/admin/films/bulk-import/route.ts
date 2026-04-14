import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { importMovie } from '@/lib/tmdb'
import { fetchAllReviews } from '@/lib/review-fetcher'
import { generateSentimentGraph } from '@/lib/sentiment-pipeline'
import { generateAndStoreWikiBeats } from '@/lib/wiki-beat-fallback'
import { apiLogger } from '@/lib/logger'

export const maxDuration = 300 // 5 minutes for Vercel

const TIME_BUDGET_MS = 280_000
const DELAY_BETWEEN_FILMS_MS = 1000

// Quality-review threshold for deciding graph vs. wiki-beat fallback. The
// main sentiment pipeline accepts as few as 1-2 quality reviews for recent
// films, but for bulk imports we want a higher bar to avoid burning Claude
// budget on films with only a single noisy review.
const MIN_QUALITY_REVIEWS_FOR_GRAPH = 3
const MIN_WORD_COUNT = 50

// Matches the isQualityReview filter in sentiment-pipeline.ts. Duplicated
// here intentionally — the task brief said do not modify the pipeline, so
// we don't export the private filter. 5 lines of duplication is cheaper
// than coupling this endpoint to pipeline internals.
const ENGLISH_REGEX =
  /^[\x00-\x7F\u00C0-\u024F\u2018-\u201D\u2014\u2013\u2026\s.,;:!?'"()\-[\]{}@#$%^&*+=/<>~`|\\]+$/

function isQualityReview(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (words.length < MIN_WORD_COUNT) return false
  if (!ENGLISH_REGEX.test(text.slice(0, 500))) return false
  return true
}

// ── TMDB list-endpoint helpers ─────────────────────────────────────────────

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

async function tmdbFetch<T>(
  endpoint: string,
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${TMDB_BASE_URL}${endpoint}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
  })
  if (!res.ok) {
    throw new Error(`TMDB ${endpoint} failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

interface TmdbListResponse {
  page: number
  total_pages: number
  results: Array<{ id: number; title?: string; release_date?: string }>
}

/**
 * Walk a paginated TMDB list endpoint until we have `maxFilms` TMDB IDs
 * or we run out of pages. Caps at 50 pages (1000 results) as a safety stop.
 */
async function fetchTmdbList(
  endpoint: string,
  maxFilms: number,
  extraParams: Record<string, string> = {}
): Promise<number[]> {
  const ids: number[] = []
  let page = 1
  const maxPages = 50

  while (ids.length < maxFilms && page <= maxPages) {
    const data = await tmdbFetch<TmdbListResponse>(endpoint, {
      ...extraParams,
      page: String(page),
    })
    for (const result of data.results) {
      if (ids.length >= maxFilms) break
      if (typeof result.id === 'number') ids.push(result.id)
    }
    if (data.page >= data.total_pages) break
    page++
  }
  return ids
}

// ── IMDb Top 250 ────────────────────────────────────────────────────────────

interface ImdbNode {
  id?: string
  tconst?: string
  imdbId?: string
}

/**
 * Fetch the IMDb Top 250 list via the imdb232 RapidAPI service, then map
 * each IMDb ID → TMDB ID via TMDB's /find endpoint.
 *
 * The exact imdb232 endpoint for the Top 250 list isn't documented in the
 * parts of the API we already use (we only use get-user-reviews and
 * get-critic-reviews). Based on the existing naming pattern the default
 * guess is `/api/title/get-top-rated-movies` — override with the
 * `RAPIDAPI_IMDB_TOP250_PATH` env var if the real endpoint is different.
 *
 * Response shape also varies between providers, so we walk a couple of
 * common JSON structures and pull out anything that looks like an IMDb
 * `tt…` id before giving up.
 */
async function fetchImdbTop250Ids(maxFilms: number): Promise<number[]> {
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY
  const RAPIDAPI_IMDB_HOST =
    process.env.RAPIDAPI_IMDB_HOST || 'imdb232.p.rapidapi.com'
  if (!RAPIDAPI_KEY) {
    throw new Error('RAPIDAPI_KEY not configured — cannot fetch IMDb Top 250')
  }

  const path =
    process.env.RAPIDAPI_IMDB_TOP250_PATH || '/api/title/get-top-rated-movies'

  const res = await fetch(`https://${RAPIDAPI_IMDB_HOST}${path}`, {
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_IMDB_HOST,
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    throw new Error(`IMDb Top 250 fetch failed: HTTP ${res.status} (${path})`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json()

  // Try several common response shapes. The walk below deliberately stops
  // at the first one that yields tt… ids so we don't merge lists.
  let rawList: unknown[] = []
  if (Array.isArray(data?.data?.topRatedTitles?.edges)) {
    rawList = data.data.topRatedTitles.edges.map(
      (e: { node?: ImdbNode }) => e.node ?? {}
    )
  } else if (Array.isArray(data?.data?.list)) {
    rawList = data.data.list
  } else if (Array.isArray(data?.results)) {
    rawList = data.results
  } else if (Array.isArray(data)) {
    rawList = data
  } else if (Array.isArray(data?.top)) {
    rawList = data.top
  }

  const imdbIds: string[] = []
  for (const item of rawList) {
    if (imdbIds.length >= maxFilms) break
    const node = item as ImdbNode
    const id = node.id || node.tconst || node.imdbId
    if (typeof id === 'string' && id.startsWith('tt')) imdbIds.push(id)
  }

  if (imdbIds.length === 0) {
    throw new Error(
      `IMDb Top 250 response missing IMDb IDs. Tried shapes data.topRatedTitles.edges, data.list, results, top. Raw keys: ${Object.keys(data ?? {}).join(',')}`
    )
  }

  // Map IMDb IDs → TMDB IDs via TMDB /find. Small delay between calls so
  // we don't burst the TMDB rate limit.
  const tmdbIds: number[] = []
  for (const imdbId of imdbIds) {
    try {
      const find = await tmdbFetch<{ movie_results: Array<{ id: number }> }>(
        `/find/${imdbId}`,
        { external_source: 'imdb_id' }
      )
      const first = find.movie_results[0]
      if (first?.id) tmdbIds.push(first.id)
    } catch (err) {
      apiLogger.warn(
        { imdbId, err: err instanceof Error ? err.message : String(err) },
        'IMDb Top 250: TMDB /find lookup failed'
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  return tmdbIds
}

// ── Main handler ────────────────────────────────────────────────────────────

interface PerFilmResult {
  tmdbId: number
  title: string
  alreadyExisted: boolean
  imdbReviewCount: number
  graph: boolean
  wikiBeats: boolean
  error?: string
}

/**
 * Bulk-import films from a configurable source, fetch reviews from all
 * sources for each one, and run the full sentiment pipeline (or fall back
 * to Wikipedia beats) based on how many quality reviews we get.
 *
 * Body shape:
 *   { source: 'tmdb_company', companyId: number, maxFilms: number }
 *   { source: 'tmdb_top_rated', maxFilms: number }
 *   { source: 'tmdb_popular',   maxFilms: number }
 *   { source: 'imdb_top_250',   maxFilms: number }
 *
 * Sequential with a 1-second delay between films (no parallel RapidAPI
 * calls — the quota is too fragile). If we approach the Vercel timeout
 * we stop cleanly and report how far we got — call again with the same
 * body to resume, already-existing films are fast-skipped.
 */
export async function POST(request: Request) {
  const session = await getMobileOrServerSession()
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json(
      { error: 'Unauthorized', code: 'FORBIDDEN' },
      { status: 403 }
    )
  }

  const body = await request.json().catch(() => ({}))
  const source = body?.source
  const rawMax = Number(body?.maxFilms)
  const maxFilms =
    Number.isFinite(rawMax) && rawMax > 0 ? Math.min(Math.floor(rawMax), 500) : 50

  const validSources = [
    'tmdb_company',
    'tmdb_top_rated',
    'tmdb_popular',
    'imdb_top_250',
  ] as const
  type ValidSource = (typeof validSources)[number]
  if (!validSources.includes(source as ValidSource)) {
    return Response.json(
      {
        error: `Invalid source. Must be one of: ${validSources.join(', ')}`,
        code: 'BAD_REQUEST',
      },
      { status: 400 }
    )
  }

  const startTime = Date.now()
  const deadline = startTime + TIME_BUDGET_MS

  try {
    // ── Step 1: resolve list of TMDB IDs to import ──
    let tmdbIds: number[] = []
    if (source === 'tmdb_company') {
      const companyId = Number(body?.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) {
        return Response.json(
          {
            error: 'companyId (positive integer) required for tmdb_company',
            code: 'BAD_REQUEST',
          },
          { status: 400 }
        )
      }
      tmdbIds = await fetchTmdbList('/discover/movie', maxFilms, {
        with_companies: String(companyId),
        sort_by: 'popularity.desc',
      })
    } else if (source === 'tmdb_top_rated') {
      tmdbIds = await fetchTmdbList('/movie/top_rated', maxFilms)
    } else if (source === 'tmdb_popular') {
      tmdbIds = await fetchTmdbList('/movie/popular', maxFilms)
    } else if (source === 'imdb_top_250') {
      tmdbIds = await fetchImdbTop250Ids(maxFilms)
    }

    const total = tmdbIds.length
    apiLogger.info(
      { source, total, maxFilms },
      `Bulk import starting: ${source} (${total} films)`
    )

    // ── Step 2: process each film sequentially ──
    const results: PerFilmResult[] = []
    let imported = 0
    let alreadyExistedCount = 0
    let graphsGenerated = 0
    let wikiBeatsGenerated = 0
    let timedOut = false
    let stoppedAtIndex = -1
    let stoppedAtTitle: string | null = null

    for (let i = 0; i < tmdbIds.length; i++) {
      const tmdbId = tmdbIds[i]

      if (Date.now() > deadline) {
        timedOut = true
        stoppedAtIndex = i
        stoppedAtTitle = `tmdbId=${tmdbId}`
        apiLogger.warn(
          { i, total, tmdbId },
          `Bulk import approaching timeout — stopping at ${i + 1}/${total}`
        )
        break
      }

      try {
        // 2a. Existence check — if already in DB, skip the whole film.
        //     This also makes re-running the same import call cheap:
        //     previously-processed films are just a fast DB lookup.
        const existing = await prisma.film.findUnique({ where: { tmdbId } })
        if (existing) {
          alreadyExistedCount++
          results.push({
            tmdbId,
            title: existing.title,
            alreadyExisted: true,
            imdbReviewCount: 0,
            graph: false,
            wikiBeats: false,
          })
          apiLogger.info(
            { filmId: existing.id, filmTitle: existing.title, n: i + 1, total },
            `Importing ${existing.title} (${i + 1}/${total})... already exists, skipping`
          )
          if (i < tmdbIds.length - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, DELAY_BETWEEN_FILMS_MS)
            )
          }
          continue
        }

        // 2b. Import from TMDB (creates Film row, syncs credits).
        const film = await importMovie(tmdbId)
        imported++

        // 2c. Fetch and store reviews from ALL sources.
        await fetchAllReviews(film)

        // 2d. Count quality + IMDb reviews to decide the pipeline branch.
        const allReviews = await prisma.review.findMany({
          where: { filmId: film.id },
          select: { reviewText: true, sourcePlatform: true },
        })
        const qualityCount = allReviews.filter((r) =>
          isQualityReview(r.reviewText)
        ).length
        const imdbReviewCount = allReviews.filter(
          (r) => r.sourcePlatform === 'IMDB'
        ).length

        // 2e. Sentiment graph if we have enough quality reviews; otherwise
        //     Wikipedia beats as fallback.
        let graphGenerated = false
        let wikiGenerated = false

        if (qualityCount >= MIN_QUALITY_REVIEWS_FOR_GRAPH) {
          try {
            await generateSentimentGraph(film.id, { force: true })
            graphGenerated = true
            graphsGenerated++
          } catch (err) {
            apiLogger.warn(
              {
                filmId: film.id,
                filmTitle: film.title,
                error: err instanceof Error ? err.message : String(err),
              },
              'Bulk import: sentiment graph failed — falling back to wiki beats'
            )
          }
        }

        if (!graphGenerated) {
          try {
            const wikiResult = await generateAndStoreWikiBeats(film.id)
            if (wikiResult.status === 'generated') {
              wikiGenerated = true
              wikiBeatsGenerated++
            }
          } catch (err) {
            apiLogger.warn(
              {
                filmId: film.id,
                filmTitle: film.title,
                error: err instanceof Error ? err.message : String(err),
              },
              'Bulk import: wiki beat fallback failed'
            )
          }
        }

        apiLogger.info(
          {
            filmId: film.id,
            filmTitle: film.title,
            n: i + 1,
            total,
            imdbReviewCount,
            qualityCount,
            graph: graphGenerated,
            wikiBeats: wikiGenerated,
          },
          `Importing ${film.title} (${i + 1}/${total})... ${imdbReviewCount} IMDb reviews, graph: ${graphGenerated ? 'yes' : 'no'}, wiki beats: ${wikiGenerated ? 'yes' : 'no'}`
        )

        results.push({
          tmdbId,
          title: film.title,
          alreadyExisted: false,
          imdbReviewCount,
          graph: graphGenerated,
          wikiBeats: wikiGenerated,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        apiLogger.error(
          { err, tmdbId, n: i + 1, total },
          `Bulk import: per-film error at ${i + 1}/${total}`
        )
        results.push({
          tmdbId,
          title: `tmdb:${tmdbId}`,
          alreadyExisted: false,
          imdbReviewCount: 0,
          graph: false,
          wikiBeats: false,
          error: message,
        })
      }

      if (i < tmdbIds.length - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, DELAY_BETWEEN_FILMS_MS)
        )
      }
    }

    const durationMs = Date.now() - startTime

    apiLogger.info(
      {
        source,
        total,
        imported,
        alreadyExisted: alreadyExistedCount,
        graphsGenerated,
        wikiBeatsGenerated,
        timedOut,
        stoppedAtIndex,
        durationMs,
      },
      `Bulk import complete: ${imported} imported, ${alreadyExistedCount} already existed, ${graphsGenerated} graphs, ${wikiBeatsGenerated} wiki beats`
    )

    return Response.json({
      source,
      total,
      imported,
      alreadyExisted: alreadyExistedCount,
      graphsGenerated,
      wikiBeatsGenerated,
      timedOut,
      stoppedAtIndex: timedOut ? stoppedAtIndex : null,
      stoppedAtTitle: timedOut ? stoppedAtTitle : null,
      results,
      durationMs,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    apiLogger.error({ err }, 'Bulk import failed')
    return Response.json(
      { error: `Bulk import failed: ${message}` },
      { status: 500 }
    )
  }
}
