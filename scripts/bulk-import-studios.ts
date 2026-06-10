/**
 * One-shot studio bulk import: top ~500 most-popular films per studio preset,
 * IMPORT-ONLY. No synchronous Claude graph call; graphs come later via the
 * Batch API drain.
 *
 * Per new film: importMovie (TMDB details/credits/keywords, person sync,
 * similar-films) -> fetchAllReviews (6 sources) -> wiki-beats fallback.
 * Already-imported films fast-skip on a DB lookup before any TMDB call, so
 * the run is idempotent and restart-safe: kill it, rerun it, it resumes.
 *
 * Quality gates: cron parity via checkCronQualityGates, with ONE difference:
 * Documentaries are ALLOWED (allowDocumentaries: true). TV Movies stay
 * excluded, as do low-vote, low-popularity, short, poster-less, and
 * overview-less films. The gate runs on fresh TMDB details BEFORE import,
 * so rejects cost one TMDB call and zero DB writes.
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
const DETAIL_DELAY_MS = 250 // after gate-reject (one TMDB call, no DB writes)
const IMPORT_DELAY_MS = 1000 // after full import; review-source quotas are fragile

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

// ── Tallies ──

interface StudioTally {
  label: string
  companyId: number
  candidates: number
  imported: number
  wouldImport: number // dry-run counterpart of imported
  skippedExisting: number
  crossStudioDup: number
  gateRejected: Record<string, number>
  graphEligible: number // imported this run with >= MIN_QUALITY_REVIEWS_FOR_GENERATION quality reviews
  wikiBeats: number
  failed: number
}

interface IncompleteFilm {
  tmdbId: number
  title: string
  failedStage: 'reviews' | 'wikiBeats'
  error: string
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

async function countQualityReviews(filmId: string): Promise<number> {
  const reviews = await prisma.review.findMany({
    where: { filmId },
    select: { reviewText: true },
  })
  return reviews.filter((r) => isQualityReview(r.reviewText)).length
}

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
process.on('SIGINT', () => {
  if (aborted) process.exit(130)
  aborted = true
  console.log('\nSIGINT: finishing the current film, then printing the summary. Ctrl-C again to force quit.')
})

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
    `${studios.length} studio(s), up to ${args.maxPerStudio} films each${args.dryRun ? ', DRY RUN (no DB writes)' : ''}\n`
  )

  const tallies: StudioTally[] = []
  const incomplete: IncompleteFilm[] = []
  // Films can belong to multiple preset companies (co-productions). Attribute
  // each tmdbId to the first studio that surfaces it this run; later studios
  // count it as a cross-studio duplicate instead of reprocessing it.
  const seenThisRun = new Set<number>()

  for (let s = 0; s < studios.length; s++) {
    if (aborted) break
    const studio = studios[s]
    const studioTag = `[${s + 1}/${studios.length} ${studio.label}]`

    console.log(`${studioTag} paging /discover/movie (with_companies=${studio.id}, popularity.desc)...`)
    let candidates: DiscoverCandidate[] = []
    try {
      candidates = await discoverCompanyFilms(studio.id, args.maxPerStudio)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`${studioTag} discover failed: ${msg}. Skipping studio.`)
      tallies.push({
        label: studio.label,
        companyId: studio.id,
        candidates: 0,
        imported: 0,
        wouldImport: 0,
        skippedExisting: 0,
        crossStudioDup: 0,
        gateRejected: {},
        graphEligible: 0,
        wikiBeats: 0,
        failed: 0,
      })
      continue
    }
    console.log(`${studioTag} ${candidates.length} unique candidates`)

    const t: StudioTally = {
      label: studio.label,
      companyId: studio.id,
      candidates: candidates.length,
      imported: 0,
      wouldImport: 0,
      skippedExisting: 0,
      crossStudioDup: 0,
      gateRejected: {},
      graphEligible: 0,
      wikiBeats: 0,
      failed: 0,
    }
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

      try {
        // 1. Fast-skip: DB existence check before any TMDB call.
        const existing = await prisma.film.findUnique({
          where: { tmdbId: candidate.id },
          select: { id: true, title: true },
        })
        if (existing) {
          t.skippedExisting++
          continue
        }

        // 2. Fresh details for the quality gate (importMovie refetches them;
        //    one duplicate TMDB call per accepted film is the price of
        //    gating before any DB write).
        const details = await getMovieDetails(candidate.id)
        const gate = checkCronQualityGates(details, { allowDocumentaries: true })
        if (!gate.pass) {
          t.gateRejected[gate.reason] = (t.gateRejected[gate.reason] ?? 0) + 1
          console.log(`${progress} GATE ${gate.reason}: ${details.title}`)
          await sleep(DETAIL_DELAY_MS)
          continue
        }

        if (args.dryRun) {
          t.wouldImport++
          console.log(`${progress} WOULD IMPORT ${details.title}`)
          await sleep(DETAIL_DELAY_MS)
          continue
        }

        // 3. Import: Film row + credits + keywords + person sync + similar films.
        const film = await importMovie(candidate.id)
        t.imported++

        // 4. Reviews from all 6 sources. A failure here leaves the film
        //    imported but review-less; it is recorded so a targeted rerun
        //    can repair it (the fast-skip would otherwise hide it forever).
        let reviewTotal = -1
        try {
          reviewTotal = await fetchAllReviews(film)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          incomplete.push({ tmdbId: candidate.id, title: film.title, failedStage: 'reviews', error: msg })
        }

        let qualityCount = 0
        try {
          qualityCount = await countQualityReviews(film.id)
        } catch {
          // Count failure only skews the run tally; the end-of-run sweep recounts everything.
        }
        if (qualityCount >= MIN_QUALITY_REVIEWS_FOR_GENERATION) t.graphEligible++

        // 5. Wiki beats so the detail page renders something until Piece 2.
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
          const msg = err instanceof Error ? err.message : String(err)
          incomplete.push({ tmdbId: candidate.id, title: film.title, failedStage: 'wikiBeats', error: msg })
          beatsNote = 'error'
        }

        console.log(
          `${progress} OK ${film.title}: reviews ${reviewTotal < 0 ? 'FAILED' : reviewTotal} (quality ${qualityCount}), beats ${beatsNote}`
        )
        await sleep(IMPORT_DELAY_MS)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        t.failed++
        console.error(`${progress} FAIL ${candidate.title}: ${msg}`)
        await sleep(DETAIL_DELAY_MS)
      }
    }

    console.log(
      `${studioTag} done: ${args.dryRun ? `${t.wouldImport} would import` : `${t.imported} imported`}, ` +
        `${t.skippedExisting} existing, ${t.crossStudioDup} cross-studio dup, ` +
        `${gateRejectedTotal(t)} gate-rejected${formatGateRejects(t)}, ${t.failed} failed\n`
    )
  }

  // ── Summary ──

  console.log('=== Per-studio results ===')
  for (const t of tallies) {
    console.log(
      `${t.label} (${t.companyId}): candidates ${t.candidates}, ` +
        `${args.dryRun ? `would-import ${t.wouldImport}` : `imported ${t.imported}`}, ` +
        `existing ${t.skippedExisting}, cross-dup ${t.crossStudioDup}, ` +
        `gate-rejected ${gateRejectedTotal(t)}${formatGateRejects(t)}, ` +
        `${args.dryRun ? '' : `graph-eligible ${t.graphEligible}, wiki-beats ${t.wikiBeats}, `}failed ${t.failed}`
    )
  }

  const sum = (f: (t: StudioTally) => number) => tallies.reduce((acc, t) => acc + f(t), 0)
  console.log('\n=== Totals ===')
  console.log(`Candidates:        ${sum((t) => t.candidates)}`)
  if (args.dryRun) {
    console.log(`Would import:      ${sum((t) => t.wouldImport)}`)
  } else {
    console.log(`Imported:          ${sum((t) => t.imported)}`)
    console.log(`Graph-eligible:    ${sum((t) => t.graphEligible)} (of this run's imports)`)
    console.log(`Wiki beats:        ${sum((t) => t.wikiBeats)}`)
  }
  console.log(`Skipped existing:  ${sum((t) => t.skippedExisting)}`)
  console.log(`Cross-studio dup:  ${sum((t) => t.crossStudioDup)}`)
  console.log(`Gate-rejected:     ${sum(gateRejectedTotal)}`)
  console.log(`Failed:            ${sum((t) => t.failed)}`)

  if (incomplete.length > 0) {
    console.log(`\n=== Incomplete films (imported, but a later stage failed) ===`)
    for (const f of incomplete) {
      console.log(`tmdbId ${f.tmdbId} ${f.title}: ${f.failedStage} failed: ${f.error}`)
    }
  }

  if (aborted) {
    console.log('\nRun aborted by SIGINT. Rerun the same command to resume; existing films fast-skip.')
  }

  // ── Cost checkpoint for Piece 2 ──
  console.log('\n=== COST CHECKPOINT (Piece 2 input) ===')
  const sweep = await costCheckpointSweep()
  console.log(`Films with no sentiment graph (ACTIVE, released): ${sweep.total}`)
  console.log(
    `  graph-eligible (>= ${MIN_QUALITY_REVIEWS_FOR_GENERATION} quality reviews): ${sweep.graphEligible}  <- multiply this by per-film batch cost`
  )
  console.log(`  below threshold (wiki-beats only):                ${sweep.belowThreshold}`)

  await prisma.$disconnect()
  process.exit(aborted ? 130 : 0)
}

main().catch(async (err) => {
  console.error('Fatal error:', err)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
