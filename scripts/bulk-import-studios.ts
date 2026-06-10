/**
 * One-shot studio bulk import: top ~500 most-popular films per studio preset,
 * IMPORT-ONLY. No synchronous Claude graph call; graphs come later via the
 * Batch API drain.
 *
 * Per new film: importMovie (TMDB details/credits/keywords) ->
 * fetchAllReviews (6 sources) -> wiki-beats fallback. The per-film credits
 * sync and similar-films recompute inside importMovie are SKIPPED for bulk
 * speed; run these once after the import completes:
 *   npx tsx scripts/backfill-persons.ts        (needs TMDB; run BEFORE cancelling TMDB)
 *   npx tsx scripts/backfill-similar-films.ts  (DB-only; run any time)
 *
 * Restart-safe in both directions:
 *   - resume: films already in the DB with reviews fast-skip on a cheap lookup.
 *   - repair: an existing film with ZERO reviews (e.g. a previous run was
 *     killed between import and review fetch) gets its review + beats stages
 *     rerun. An existing film with reviews but no beats and no graph gets a
 *     beats-only attempt. So rerunning the same command heals interruptions.
 *
 * A durable run log (JSONL, appended at ./bulk-import-studios-run.jsonl)
 * records every imported / repaired / failed film with per-film review,
 * quality, and IMDb counts, so partial runs and quota incidents can be
 * audited and repaired after the fact.
 *
 * Transient DB/network outages: connection-type failures probe the DB until
 * it recovers (up to 60 minutes) and retry the same candidate, instead of
 * failing one candidate per connection timeout for the whole outage. The
 * IMDb quota warning only counts real fetch failures reported by the RapidAPI
 * host itself; films that merely have no IMDb reviews or no IMDb id cannot
 * trip it.
 *
 * Quality gates: cron parity via checkCronQualityGates, with TWO differences:
 * Documentaries are ALLOWED (allowDocumentaries: true), and the popularity
 * floor is SKIPPED (skipPopularityCheck: true; TMDB popularity is a
 * current-trending metric and would permanently reject famous older films
 * in a one-shot archival pull). TV Movies stay excluded, as do low-vote,
 * short, poster-less, and overview-less films. The cron keeps both original
 * gates. The gate runs on fresh TMDB details BEFORE import, so rejects cost
 * one TMDB call and zero DB writes. Repairs of films already in the DB
 * intentionally skip the gate.
 *
 * GATED: this mutates the shared Neon (prod/preview) database. Do not run
 * without explicit go-ahead. Even --dry-run reads prod (existence checks and
 * the cost-checkpoint sweep).
 *
 * Usage:
 *   npx tsx scripts/bulk-import-studios.ts --dry-run         # gate + tally, no DB writes
 *   npx tsx scripts/bulk-import-studios.ts                   # real run, all preset studios
 *   npx tsx scripts/bulk-import-studios.ts --company 420     # single studio (testing)
 *   npx tsx scripts/bulk-import-studios.ts --company 3,10342 # subset
 *   npx tsx scripts/bulk-import-studios.ts --max 50          # per-studio cap (default 500)
 */
import './_load-env'
import './_neon-ws'

import { appendFileSync } from 'node:fs'
import type { Film } from '../src/generated/prisma/client'
import { prisma } from '../src/lib/prisma'
import { COMPANY_PRESETS } from '../src/lib/company-presets'
import { importMovie, getMovieDetails } from '../src/lib/tmdb'
import { fetchAllReviews } from '../src/lib/review-fetcher'
import { generateAndStoreWikiBeats } from '../src/lib/wiki-beat-fallback'
import { checkCronQualityGates } from '../src/lib/cron-quality-gates'
import {
  isQualityReview,
  MIN_QUALITY_REVIEWS_FOR_GENERATION,
} from '../src/lib/sentiment-pipeline'

const DEFAULT_MAX_PER_STUDIO = 500
const DISCOVER_MAX_PAGES = 50 // safety stop, same as the admin route
const DISCOVER_PAGE_DELAY_MS = 250
const DETAIL_DELAY_MS = 250 // after gate-reject or beats-only work (cheap calls)
const IMPORT_DELAY_MS = 1000 // after full import or repair; review-source quotas are fragile
// Consecutive films where the IMDb SOURCE itself failed (HTTP error from the
// RapidAPI host). Films that merely have no IMDb reviews, or no IMDb id, do
// not count: two full-run false alarms proved deep-catalog blocks make that
// signal worthless.
const IMDB_FAILURE_WARN_STREAK = 10

const RUN_LOG_PATH = 'bulk-import-studios-run.jsonl'

const TMDB_API_KEY = process.env.TMDB_API_KEY
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

// ── CLI args ──

interface Args {
  dryRun: boolean
  companies: number[]
  maxPerStudio: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, companies: [], maxPerStudio: DEFAULT_MAX_PER_STUDIO }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') {
      args.dryRun = true
    } else if (a === '--company') {
      const raw = argv[++i] ?? ''
      for (const part of raw.split(',')) {
        const n = Number(part)
        if (!Number.isInteger(n) || n <= 0) {
          console.error(`Invalid --company value: "${part}" (expected a TMDB company id)`)
          process.exit(1)
        }
        args.companies.push(n)
      }
    } else if (a === '--max') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n <= 0) {
        console.error('Invalid --max value (expected a positive integer)')
        process.exit(1)
      }
      args.maxPerStudio = Math.min(n, DEFAULT_MAX_PER_STUDIO)
    } else {
      console.error(`Unknown argument: ${a}`)
      console.error('Usage: npx tsx scripts/bulk-import-studios.ts [--dry-run] [--company <id>[,<id>...]] [--max <n>]')
      process.exit(1)
    }
  }
  return args
}

// ── Run log (durable JSONL, survives crashes and closed terminals) ──

function logEvent(event: Record<string, unknown>): void {
  try {
    appendFileSync(RUN_LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`)
  } catch {
    // A logging failure must never kill the run.
  }
}

// ── TMDB discover pager (lib tmdbFetch is module-private, so a local copy) ──

interface DiscoverResult {
  page: number
  total_pages: number
  results: Array<{ id: number; title?: string }>
}

interface DiscoverCandidate {
  id: number
  title: string
}

async function tmdbList(endpoint: string, params: Record<string, string>): Promise<DiscoverResult> {
  const url = new URL(`${TMDB_BASE_URL}${endpoint}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
  })
  if (!res.ok) {
    throw new Error(`TMDB ${endpoint}: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<DiscoverResult>
}

/**
 * Page /discover/movie by popularity.desc until maxFilms unique ids or pages
 * run out. Dedupes by id within the studio: popularity-sorted discover is not
 * a stable order, the same id can appear on consecutive pages (same caveat as
 * the admin route's fetchTmdbList).
 */
async function discoverCompanyFilms(companyId: number, maxFilms: number): Promise<DiscoverCandidate[]> {
  const out: DiscoverCandidate[] = []
  const seen = new Set<number>()
  let page = 1
  while (out.length < maxFilms && page <= DISCOVER_MAX_PAGES) {
    const data = await tmdbList('/discover/movie', {
      with_companies: String(companyId),
      sort_by: 'popularity.desc',
      page: String(page),
    })
    for (const result of data.results) {
      if (out.length >= maxFilms) break
      if (typeof result.id !== 'number' || seen.has(result.id)) continue
      seen.add(result.id)
      out.push({ id: result.id, title: result.title ?? `tmdb:${result.id}` })
    }
    if (data.page >= data.total_pages) break
    page++
    await sleep(DISCOVER_PAGE_DELAY_MS)
  }
  return out
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Neon adapter and undici sometimes throw plain objects; "[object Object]"
 *  in a failure log is useless, so serialize properly. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err).slice(0, 300)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

function isConnectionError(msg: string): boolean {
  return /connection|terminated|fetch failed|econn|etimedout|socket|websocket|network/i.test(msg)
}

/**
 * After a connection-type failure, probe the DB until it answers instead of
 * burning one candidate per ~30s timeout for the whole outage (observed: a
 * transient network drop failed 114 candidates in a row before recovering).
 * Gives up after 60 minutes so a permanent outage still surfaces as failures
 * rather than an infinite hang. Returns early on abort.
 */
async function waitForDbRecovery(): Promise<void> {
  const giveUpAt = Date.now() + 60 * 60_000
  let delay = 15_000
  while (!aborted && Date.now() < giveUpAt) {
    await sleep(delay)
    try {
      await prisma.$queryRaw`SELECT 1`
      console.log('DB reachable again, resuming')
      return
    } catch {
      console.log(`DB still unreachable, next probe in ${Math.round(delay / 1000)}s`)
      delay = Math.min(delay * 2, 300_000)
    }
  }
}

// ── Tallies ──

interface StudioTally {
  label: string
  companyId: number
  candidates: number
  imported: number // new film, full pipeline
  repaired: number // existing film with zero reviews, stages rerun
  beatsBackfilled: number // existing film with reviews but no beats/graph, beats attempt
  wouldImport: number // dry-run counterpart of imported
  wouldRepair: number // dry-run counterpart of repaired + beatsBackfilled
  skippedExisting: number
  crossStudioDup: number
  gateRejected: Record<string, number>
  graphEligible: number // imported or repaired this run with enough quality reviews
  wikiBeats: number // beats actually generated (any path)
  failed: number
}

interface IncompleteFilm {
  tmdbId: number
  title: string
  failedStage: 'reviews' | 'wikiBeats'
  error: string
}

function emptyTally(label: string, companyId: number): StudioTally {
  return {
    label,
    companyId,
    candidates: 0,
    imported: 0,
    repaired: 0,
    beatsBackfilled: 0,
    wouldImport: 0,
    wouldRepair: 0,
    skippedExisting: 0,
    crossStudioDup: 0,
    gateRejected: {},
    graphEligible: 0,
    wikiBeats: 0,
    failed: 0,
  }
}

function gateRejectedTotal(t: StudioTally): number {
  return Object.values(t.gateRejected).reduce((a, b) => a + b, 0)
}

function formatGateRejects(t: StudioTally): string {
  const parts = Object.entries(t.gateRejected)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} ${n}`)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

async function countReviewStats(filmId: string): Promise<{ quality: number; imdb: number }> {
  const reviews = await prisma.review.findMany({
    where: { filmId },
    select: { reviewText: true, sourcePlatform: true },
  })
  let quality = 0
  let imdb = 0
  for (const r of reviews) {
    if (isQualityReview(r.reviewText)) quality++
    if (r.sourcePlatform === 'IMDB') imdb++
  }
  return { quality, imdb }
}

// ── Post-import stages (shared by fresh imports and zero-review repairs) ──

interface StageOutcome {
  reviewTotal: number // -1 when the fetch itself failed
  quality: number
  imdb: number
  /** Set when the IMDb source returned a real failure (HTTP error), as
   *  opposed to "this film has no IMDb reviews" or "no IMDb id". */
  imdbFailure: string | null
  beatsNote: string
}

async function runReviewAndBeatStages(
  film: Film,
  t: StudioTally,
  incomplete: IncompleteFilm[]
): Promise<StageOutcome> {
  let reviewTotal = -1
  let imdbFailure: string | null = null
  try {
    reviewTotal = await fetchAllReviews(film, {
      onPerSource: (perSource) => {
        const imdbResult = perSource['IMDb']
        if (
          imdbResult &&
          !imdbResult.ok &&
          imdbResult.reason !== 'film missing imdbId' &&
          imdbResult.reason !== 'no RAPIDAPI_KEY'
        ) {
          imdbFailure = imdbResult.reason ?? 'unknown failure'
        }
      },
    })
  } catch (err) {
    const msg = errMsg(err)
    incomplete.push({ tmdbId: film.tmdbId, title: film.title, failedStage: 'reviews', error: msg })
    logEvent({ event: 'incomplete', stage: 'reviews', tmdbId: film.tmdbId, title: film.title, error: msg })
  }

  let quality = 0
  let imdb = 0
  try {
    const stats = await countReviewStats(film.id)
    quality = stats.quality
    imdb = stats.imdb
  } catch {
    // Count failure only skews the run tally; the end-of-run sweep recounts everything.
  }
  if (quality >= MIN_QUALITY_REVIEWS_FOR_GENERATION) t.graphEligible++

  let beatsNote = 'no'
  try {
    const wiki = await generateAndStoreWikiBeats(film.id)
    if (wiki.status === 'generated') {
      t.wikiBeats++
      beatsNote = `yes (${wiki.beatCount})`
    } else {
      beatsNote = wiki.status
    }
  } catch (err) {
    const msg = errMsg(err)
    incomplete.push({ tmdbId: film.tmdbId, title: film.title, failedStage: 'wikiBeats', error: msg })
    logEvent({ event: 'incomplete', stage: 'wikiBeats', tmdbId: film.tmdbId, title: film.title, error: msg })
    beatsNote = 'error'
  }

  return { reviewTotal, quality, imdb, imdbFailure, beatsNote }
}

// ── Cost checkpoint ──

/**
 * Cost checkpoint: every ACTIVE, released film with no sentiment graph,
 * split by whether it clears the pipeline's quality-review threshold.
 * graphEligible is the number that the Batch API drain (Piece 2) would
 * actually send to Claude; belowThreshold films stay on wiki beats.
 *
 * Mirrors the cron candidate filter (status ACTIVE, releaseDate null or
 * past, sentimentGraph null). Quality is computed in-process with the same
 * isQualityReview the pipeline uses, because Film.lastReviewCount is only
 * written after a graph exists and is therefore empty for fresh imports.
 */
async function costCheckpointSweep(): Promise<{
  total: number
  graphEligible: number
  belowThreshold: number
}> {
  const graphless = await prisma.film.findMany({
    where: {
      status: 'ACTIVE',
      sentimentGraph: { is: null },
      OR: [{ releaseDate: null }, { releaseDate: { lte: new Date() } }],
    },
    select: { id: true },
  })

  let graphEligible = 0
  const CHUNK = 100
  for (let i = 0; i < graphless.length; i += CHUNK) {
    const chunk = graphless.slice(i, i + CHUNK)
    const reviews = await prisma.review.findMany({
      where: { filmId: { in: chunk.map((f) => f.id) } },
      select: { filmId: true, reviewText: true },
    })
    const counts = new Map<string, number>()
    for (const r of reviews) {
      if (isQualityReview(r.reviewText)) {
        counts.set(r.filmId, (counts.get(r.filmId) ?? 0) + 1)
      }
    }
    for (const f of chunk) {
      if ((counts.get(f.id) ?? 0) >= MIN_QUALITY_REVIEWS_FOR_GENERATION) graphEligible++
    }
  }

  return {
    total: graphless.length,
    graphEligible,
    belowThreshold: graphless.length - graphEligible,
  }
}

// ── Main ──

let aborted = false
function requestAbort(signal: string) {
  if (aborted) process.exit(130)
  aborted = true
  console.log(`\n${signal}: finishing the current film, then printing the summary. Repeat to force quit.`)
}
process.on('SIGINT', () => requestAbort('SIGINT'))
process.on('SIGTERM', () => requestAbort('SIGTERM'))

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!TMDB_API_KEY) {
    console.error('Missing TMDB_API_KEY in environment')
    process.exit(1)
  }
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in environment')
    process.exit(1)
  }

  let studios = COMPANY_PRESETS
  if (args.companies.length > 0) {
    studios = COMPANY_PRESETS.filter((p) => args.companies.includes(p.id))
    const known = new Set(studios.map((s) => s.id))
    const unknown = args.companies.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      console.error(
        `Unknown company id(s): ${unknown.join(', ')}. Only preset ids are allowed; see src/lib/company-presets.ts`
      )
      process.exit(1)
    }
  }

  console.log('=== Studio Bulk Import (import-only) ===')
  console.log(
    `${studios.length} studio(s), up to ${args.maxPerStudio} films each${args.dryRun ? ', DRY RUN (no DB writes)' : ''}`
  )
  console.log(`Run log: ${RUN_LOG_PATH} (JSONL, appended)\n`)
  logEvent({ event: 'run_start', dryRun: args.dryRun, maxPerStudio: args.maxPerStudio, studios: studios.map((s) => s.id) })

  const tallies: StudioTally[] = []
  const incomplete: IncompleteFilm[] = []
  // Films can belong to multiple preset companies (co-productions). Attribute
  // each tmdbId to the first studio that surfaces it this run; later studios
  // count it as a cross-studio duplicate instead of reprocessing it.
  const seenThisRun = new Set<number>()
  // Consecutive films where the IMDb source returned a real failure. Other
  // sources keep working when RapidAPI dies, so nothing throws, and only
  // this counter makes it visible.
  let imdbFailureStreak = 0

  for (let s = 0; s < studios.length; s++) {
    if (aborted) break
    const studio = studios[s]
    const studioTag = `[${s + 1}/${studios.length} ${studio.label}]`

    console.log(`${studioTag} paging /discover/movie (with_companies=${studio.id}, popularity.desc)...`)
    let candidates: DiscoverCandidate[] = []
    try {
      candidates = await discoverCompanyFilms(studio.id, args.maxPerStudio)
    } catch (err) {
      const msg = errMsg(err)
      console.error(`${studioTag} discover failed: ${msg}. Skipping studio; rerun to retry it.`)
      logEvent({ event: 'discover_failed', companyId: studio.id, studio: studio.label, error: msg })
      tallies.push(emptyTally(studio.label, studio.id))
      continue
    }
    console.log(`${studioTag} ${candidates.length} unique candidates`)

    const t = emptyTally(studio.label, studio.id)
    t.candidates = candidates.length
    tallies.push(t)

    for (let i = 0; i < candidates.length; i++) {
      if (aborted) break
      const candidate = candidates[i]
      const progress = `${studioTag} [${i + 1}/${candidates.length}]`

      if (seenThisRun.has(candidate.id)) {
        t.crossStudioDup++
        continue
      }
      seenThisRun.add(candidate.id)

      const processCandidate = async (): Promise<void> => {
        // 1. Existence + completeness check before any TMDB call.
        const existing = await prisma.film.findUnique({
          where: { tmdbId: candidate.id },
          select: {
            id: true,
            title: true,
            _count: { select: { reviews: true } },
            filmBeats: { select: { id: true } },
            sentimentGraph: { select: { id: true } },
          },
        })

        if (existing) {
          const hasReviews = existing._count.reviews > 0
          const hasBeats = existing.filmBeats !== null
          const hasGraph = existing.sentimentGraph !== null

          if (hasReviews && (hasBeats || hasGraph)) {
            t.skippedExisting++
            return
          }

          if (args.dryRun) {
            t.wouldRepair++
            console.log(
              `${progress} WOULD REPAIR ${existing.title} (${hasReviews ? 'beats only' : 'reviews + beats'})`
            )
            return
          }

          if (!hasReviews) {
            // A previous run (or the old import script) created the film but
            // reviews never landed. Rerun the full post-import stages. The
            // quality gate is intentionally skipped: the film is already live.
            const film = await prisma.film.findUniqueOrThrow({ where: { tmdbId: candidate.id } })
            const outcome = await runReviewAndBeatStages(film, t, incomplete)
            t.repaired++
            logEvent({
              event: 'repaired',
              tmdbId: candidate.id,
              title: film.title,
              studio: studio.label,
              reviews: outcome.reviewTotal,
              quality: outcome.quality,
              imdb: outcome.imdb,
              imdbFailure: outcome.imdbFailure ?? undefined,
              beats: outcome.beatsNote,
            })
            console.log(
              `${progress} REPAIRED ${film.title}: reviews ${outcome.reviewTotal < 0 ? 'FAILED' : outcome.reviewTotal} (quality ${outcome.quality}), beats ${outcome.beatsNote}`
            )
            if (outcome.reviewTotal >= 0) {
              imdbFailureStreak = outcome.imdbFailure ? imdbFailureStreak + 1 : 0
              warnOnImdbFailureStreak(imdbFailureStreak, outcome.imdbFailure)
            }
            await sleep(IMPORT_DELAY_MS)
          } else {
            // Reviews exist but the film renders nothing: attempt wiki beats.
            let note = 'no'
            try {
              const wiki = await generateAndStoreWikiBeats(existing.id)
              if (wiki.status === 'generated') {
                t.wikiBeats++
                note = `yes (${wiki.beatCount})`
              } else {
                note = wiki.status
              }
            } catch (err) {
              const msg = errMsg(err)
              incomplete.push({ tmdbId: candidate.id, title: existing.title, failedStage: 'wikiBeats', error: msg })
              logEvent({ event: 'incomplete', stage: 'wikiBeats', tmdbId: candidate.id, title: existing.title, error: msg })
              note = 'error'
            }
            t.beatsBackfilled++
            console.log(`${progress} BEATS ${existing.title}: ${note}`)
            await sleep(DETAIL_DELAY_MS)
          }
          return
        }

        // 2. Fresh details for the quality gate (importMovie refetches them;
        //    one duplicate TMDB call per accepted film is the price of
        //    gating before any DB write).
        const details = await getMovieDetails(candidate.id)
        const gate = checkCronQualityGates(details, {
          allowDocumentaries: true,
          skipPopularityCheck: true,
        })
        if (!gate.pass) {
          t.gateRejected[gate.reason] = (t.gateRejected[gate.reason] ?? 0) + 1
          console.log(`${progress} GATE ${gate.reason}: ${details.title}`)
          await sleep(DETAIL_DELAY_MS)
          return
        }

        if (args.dryRun) {
          t.wouldImport++
          console.log(`${progress} WOULD IMPORT ${details.title}`)
          await sleep(DETAIL_DELAY_MS)
          return
        }

        // 3. Import the Film row (credits sync and similar-films recompute
        //    are deferred to the end-of-run backfill scripts).
        const film = await importMovie(candidate.id, {
          skipCreditsSync: true,
          skipSimilarRecompute: true,
        })
        t.imported++

        // 4 + 5. Reviews from all 6 sources, then wiki beats so the detail
        //        page renders something until Piece 2.
        const outcome = await runReviewAndBeatStages(film, t, incomplete)
        logEvent({
          event: 'imported',
          tmdbId: candidate.id,
          title: film.title,
          studio: studio.label,
          reviews: outcome.reviewTotal,
          quality: outcome.quality,
          imdb: outcome.imdb,
          imdbFailure: outcome.imdbFailure ?? undefined,
          beats: outcome.beatsNote,
        })
        console.log(
          `${progress} OK ${film.title}: reviews ${outcome.reviewTotal < 0 ? 'FAILED' : outcome.reviewTotal} (quality ${outcome.quality}), beats ${outcome.beatsNote}`
        )
        if (outcome.reviewTotal >= 0) {
          imdbFailureStreak = outcome.imdbFailure ? imdbFailureStreak + 1 : 0
          warnOnImdbFailureStreak(imdbFailureStreak, outcome.imdbFailure)
        }
        await sleep(IMPORT_DELAY_MS)
      }

      // Connection-type failures wait for the DB to answer again and retry
      // the SAME candidate (up to twice) instead of consuming the queue at
      // one candidate per connection timeout. Everything else fails the
      // candidate immediately; rerunning the script picks failures back up.
      let attempt = 0
      while (true) {
        try {
          await processCandidate()
          break
        } catch (err) {
          const msg = errMsg(err)
          attempt++
          if (isConnectionError(msg) && attempt <= 2 && !aborted) {
            console.warn(
              `${progress} connection error: ${msg.slice(0, 120)}. Probing DB before retrying (attempt ${attempt}/2).`
            )
            logEvent({ event: 'retry', tmdbId: candidate.id, title: candidate.title, attempt, error: msg.slice(0, 200) })
            await waitForDbRecovery()
            continue
          }
          t.failed++
          logEvent({ event: 'failed', tmdbId: candidate.id, title: candidate.title, studio: studio.label, error: msg })
          console.error(`${progress} FAIL ${candidate.title}: ${msg}`)
          await sleep(DETAIL_DELAY_MS)
          break
        }
      }
    }

    console.log(
      `${studioTag} done: ${
        args.dryRun
          ? `${t.wouldImport} would import, ${t.wouldRepair} would repair`
          : `${t.imported} imported, ${t.repaired} repaired, ${t.beatsBackfilled} beats-backfilled`
      }, ${t.skippedExisting} existing, ${t.crossStudioDup} cross-studio dup, ` +
        `${gateRejectedTotal(t)} gate-rejected${formatGateRejects(t)}, ${t.failed} failed\n`
    )
  }

  // ── Summary ──

  console.log('=== Per-studio results ===')
  for (const t of tallies) {
    console.log(
      `${t.label} (${t.companyId}): candidates ${t.candidates}, ` +
        `${
          args.dryRun
            ? `would-import ${t.wouldImport}, would-repair ${t.wouldRepair}`
            : `imported ${t.imported}, repaired ${t.repaired}, beats-backfilled ${t.beatsBackfilled}`
        }, existing ${t.skippedExisting}, cross-dup ${t.crossStudioDup}, ` +
        `gate-rejected ${gateRejectedTotal(t)}${formatGateRejects(t)}, ` +
        `${args.dryRun ? '' : `graph-eligible ${t.graphEligible}, wiki-beats ${t.wikiBeats}, `}failed ${t.failed}`
    )
  }

  const sum = (f: (t: StudioTally) => number) => tallies.reduce((acc, t) => acc + f(t), 0)
  console.log('\n=== Totals ===')
  console.log(`Candidates:        ${sum((t) => t.candidates)}`)
  if (args.dryRun) {
    console.log(`Would import:      ${sum((t) => t.wouldImport)}`)
    console.log(`Would repair:      ${sum((t) => t.wouldRepair)}`)
  } else {
    console.log(`Imported:          ${sum((t) => t.imported)}`)
    console.log(`Repaired:          ${sum((t) => t.repaired)}`)
    console.log(`Beats-backfilled:  ${sum((t) => t.beatsBackfilled)}`)
    console.log(`Graph-eligible:    ${sum((t) => t.graphEligible)} (of this run's imports + repairs)`)
    console.log(`Wiki beats:        ${sum((t) => t.wikiBeats)}`)
  }
  console.log(`Skipped existing:  ${sum((t) => t.skippedExisting)}`)
  console.log(`Cross-studio dup:  ${sum((t) => t.crossStudioDup)}`)
  console.log(`Gate-rejected:     ${sum(gateRejectedTotal)}`)
  console.log(`Failed:            ${sum((t) => t.failed)}`)

  if (incomplete.length > 0) {
    console.log(`\n=== Incomplete films (imported, but a later stage failed; also in ${RUN_LOG_PATH}) ===`)
    for (const f of incomplete) {
      console.log(`tmdbId ${f.tmdbId} ${f.title}: ${f.failedStage} failed: ${f.error}`)
    }
    console.log('Rerunning the same command repairs zero-review films automatically.')
  }

  if (aborted) {
    console.log('\nRun aborted by signal. Rerun the same command to resume; it also repairs films left half-done.')
  }

  if (!args.dryRun) {
    console.log('\nDeferred per-film work. Run once after the import is fully done:')
    console.log('  npx tsx scripts/backfill-persons.ts        (needs TMDB; run BEFORE cancelling TMDB)')
    console.log('  npx tsx scripts/backfill-similar-films.ts  (DB-only; run any time)')
  }

  // ── Cost checkpoint for Piece 2 ──
  console.log('\n=== COST CHECKPOINT (Piece 2 input) ===')
  const sweep = await costCheckpointSweep()
  console.log(`Films with no sentiment graph (ACTIVE, released): ${sweep.total}`)
  console.log(
    `  graph-eligible (>= ${MIN_QUALITY_REVIEWS_FOR_GENERATION} quality reviews): ${sweep.graphEligible}  <- multiply this by per-film batch cost`
  )
  console.log(`  below threshold (wiki-beats only):                ${sweep.belowThreshold}`)
  logEvent({ event: 'run_end', aborted, sweep })

  await prisma.$disconnect()
  process.exit(aborted ? 130 : 0)
}

function warnOnImdbFailureStreak(streak: number, lastReason: string | null): void {
  if (streak === IMDB_FAILURE_WARN_STREAK) {
    console.warn(
      `\nWARNING: ${IMDB_FAILURE_WARN_STREAK} consecutive films where the IMDb source FAILED ` +
        `(last reason: ${lastReason ?? 'unknown'}). This is a real fetch failure from the RapidAPI host, ` +
        'likely quota or rate-limit exhaustion. Other sources keep working, so the run continues, ' +
        `but affected films are logged with an imdbFailure field in ${RUN_LOG_PATH}. ` +
        'Consider Ctrl-C now and resuming after the quota resets.\n'
    )
  }
}

main().catch(async (err) => {
  console.error('Fatal error:', err)
  logEvent({ event: 'fatal', error: errMsg(err) })
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
