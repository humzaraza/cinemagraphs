/**
 * Fix missing runtimes from TMDB, then regenerate the graphs built on them.
 *
 * For every Film with runtime NULL or <= 0 (runtime is stored as 0 when
 * unknown, so the test is `<= 0`):
 *   1. GET /movie/{tmdbId} on TMDB.
 *   2. runtime > 0           -> update Film.runtime to the TMDB value.
 *      no runtime, unreleased -> skip and list (status not Released, or no
 *                                or future release date). Nothing is guessed.
 *      no runtime, released   -> skip and list.
 *      lookup error           -> skip and list.
 *   3. For fixed films that already have a SentimentGraph, regenerate it
 *      through generateHybridAndStore (the admin Regenerate path): fresh
 *      reviews, Wikipedia plot, model call, then the beat-lock write. Films
 *      with no user beat ratings get their beats replaced outright; films
 *      with ratings merge. Pre-release films are skipped by that path.
 *
 * Skipped films keep their graphs. Whether a graph on an unreleased film
 * should exist at all is a separate decision; this script lists them.
 *
 * --dry-run: TMDB lookups only (read-only, third-party), no DB writes, no
 * model calls. Prints exactly what --commit would do.
 * --expect-host is required in both modes.
 *
 * Usage:
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/fix-runtimes-and-regenerate.ts --dry-run --expect-host plain-shadow
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/fix-runtimes-and-regenerate.ts --commit  --expect-host plain-shadow
 *   ... --skip-regen        fix runtimes only
 *   ... --film-ids a,b,c    restrict to these films
 */
import './_load-env'
import './_neon-ws'

import { prisma } from '../src/lib/prisma'
import { generateHybridAndStore } from '../src/lib/sentiment-pipeline'
import { invalidateFilmCache } from '../src/lib/cache'

const TMDB_API_KEY = process.env.TMDB_API_KEY
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'
const TMDB_GAP_MS = 60
const REGEN_GAP_MS = 2000

interface Args {
  dryRun: boolean
  commit: boolean
  expectHost: string
  skipRegen: boolean
  filmIds: Set<string> | null
}

type Bucket = 'fixable' | 'unreleased' | 'released_no_runtime' | 'error'

interface Outcome {
  filmId: string
  tmdbId: number
  title: string
  hasGraph: boolean
  bucket: Bucket
  runtime?: number
  tmdbStatus?: string
  tmdbReleaseDate?: string
  error?: string
}

function parseArgs(argv: string[]): Args {
  let dryRun = false
  let commit = false
  let skipRegen = false
  let expectHost: string | null = null
  let filmIds: Set<string> | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--commit') commit = true
    else if (a === '--skip-regen') skipRegen = true
    else if (a === '--expect-host') {
      expectHost = argv[++i] ?? null
      if (!expectHost) throw new Error('--expect-host requires a substring')
    } else if (a === '--film-ids') {
      const raw = argv[++i]
      if (!raw) throw new Error('--film-ids requires a comma-separated list')
      filmIds = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
    } else throw new Error(`Unknown argument: ${a}`)
  }
  if (!dryRun && !commit) throw new Error('Must pass --dry-run or --commit')
  if (dryRun && commit) throw new Error('Cannot pass both --dry-run and --commit')
  if (!expectHost) throw new Error('--expect-host <substring> is required (production is plain-shadow)')
  return { dryRun, commit, expectHost, skipRegen, filmIds }
}

function databaseHost(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  try {
    return new URL(url).host
  } catch {
    return '<unparseable DATABASE_URL>'
  }
}

interface TmdbMovie {
  title?: string
  runtime?: number | null
  status?: string
  release_date?: string
}

async function fetchMovie(tmdbId: number): Promise<TmdbMovie> {
  const res = await fetch(`${TMDB_BASE_URL}/movie/${tmdbId}`, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
  })
  if (!res.ok) throw new Error(`TMDB ${res.status} ${res.statusText}`)
  return (await res.json()) as TmdbMovie
}

function classify(
  film: { id: string; tmdbId: number; title: string; hasGraph: boolean },
  movie: TmdbMovie,
  today: string
): Outcome {
  const base: Outcome = {
    filmId: film.id,
    tmdbId: film.tmdbId,
    title: film.title,
    hasGraph: film.hasGraph,
    bucket: 'error',
    tmdbStatus: movie.status,
    tmdbReleaseDate: movie.release_date || undefined,
  }
  const runtime = movie.runtime
  if (typeof runtime === 'number' && Number.isInteger(runtime) && runtime > 0) {
    return { ...base, bucket: 'fixable', runtime }
  }
  const unreleased =
    movie.status !== 'Released' || !movie.release_date || movie.release_date > today
  return { ...base, bucket: unreleased ? 'unreleased' : 'released_no_runtime' }
}

function printBucket(label: string, items: Outcome[]): void {
  console.log(`\n${label} (${items.length}):`)
  for (const o of items) {
    const bits = [
      o.filmId,
      `tmdbId=${o.tmdbId}`,
      `"${o.title}"`,
      o.hasGraph ? 'HAS GRAPH' : 'no graph',
      o.runtime !== undefined ? `runtime=${o.runtime}` : null,
      o.tmdbStatus ? `status=${o.tmdbStatus}` : null,
      o.tmdbReleaseDate ? `release=${o.tmdbReleaseDate}` : 'release=none',
      o.error ? `error=${o.error}` : null,
    ].filter(Boolean)
    console.log(`  ${bits.join('  ')}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const host = databaseHost()
  console.log(`[db] host=${host}`)
  if (!host.includes(args.expectHost)) {
    console.error(`[db] host does not contain "${args.expectHost}"; aborting before any read or write`)
    process.exit(1)
  }
  if (!TMDB_API_KEY) {
    console.error('TMDB_API_KEY is not set')
    process.exit(1)
  }
  console.log(`fix-runtimes-and-regenerate: ${args.dryRun ? 'DRY RUN (TMDB lookups only)' : 'COMMIT'}`)

  const filmsRaw = await prisma.film.findMany({
    where: { OR: [{ runtime: null }, { runtime: { lte: 0 } }] },
    select: { id: true, tmdbId: true, title: true, runtime: true, sentimentGraph: { select: { id: true } } },
    orderBy: { title: 'asc' },
  })
  const films = filmsRaw
    .map((f) => ({ id: f.id, tmdbId: f.tmdbId, title: f.title, hasGraph: f.sentimentGraph !== null }))
    .filter((f) => !args.filmIds || args.filmIds.has(f.id))
  console.log(`Films with runtime NULL or <= 0: ${filmsRaw.length}${args.filmIds ? ` (targeting ${films.length})` : ''}`)

  const today = new Date().toISOString().slice(0, 10)
  const outcomes: Outcome[] = []
  for (const film of films) {
    try {
      outcomes.push(classify(film, await fetchMovie(film.tmdbId), today))
    } catch (err) {
      outcomes.push({
        filmId: film.id,
        tmdbId: film.tmdbId,
        title: film.title,
        hasGraph: film.hasGraph,
        bucket: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
    await new Promise((r) => setTimeout(r, TMDB_GAP_MS))
  }

  const by = (b: Bucket) => outcomes.filter((o) => o.bucket === b)
  const fixable = by('fixable')
  const toRegen = fixable.filter((o) => o.hasGraph)

  console.log('\n=== PLAN ===')
  console.log(`  runtime fixes:           ${fixable.length}`)
  console.log(`  graphs to regenerate:    ${toRegen.length}${args.skipRegen ? ' (skipped: --skip-regen)' : ''}`)
  console.log(`  unreleased, left alone:  ${by('unreleased').length}  (${by('unreleased').filter((o) => o.hasGraph).length} with a graph)`)
  console.log(`  released, TMDB has no runtime, left alone: ${by('released_no_runtime').length}`)
  console.log(`  lookup errors:           ${by('error').length}`)

  printBucket('FIX', fixable)
  printBucket('UNRELEASED (no runtime on TMDB; left alone, do not guess)', by('unreleased'))
  printBucket('RELEASED BUT TMDB HAS NO RUNTIME (left alone)', by('released_no_runtime'))
  printBucket('LOOKUP ERRORS (left alone)', by('error'))

  if (args.dryRun) {
    console.log('\nDry run complete. No DB writes, no model calls.')
    await prisma.$disconnect()
    return
  }

  console.log('\n--- updating runtimes ---')
  let fixed = 0
  for (const o of fixable) {
    // Guarded like the SQL template: only rows still missing a runtime.
    const result = await prisma.film.updateMany({
      where: { id: o.filmId, OR: [{ runtime: null }, { runtime: { lte: 0 } }] },
      data: { runtime: o.runtime },
    })
    if (result.count === 1) {
      fixed++
      console.log(`  ✓ "${o.title}" runtime -> ${o.runtime}`)
    } else {
      console.log(`  ~ "${o.title}" already had a runtime; left as is`)
    }
    await invalidateFilmCache(o.filmId).catch(() => {})
  }

  let regenerated = 0
  let regenSkipped = 0
  let regenFailed = 0
  if (!args.skipRegen) {
    console.log('\n--- regenerating graphs ---')
    for (const o of toRegen) {
      try {
        const result = await generateHybridAndStore(o.filmId, { force: true, callerPath: 'script-fix-runtimes' })
        if (result.status === 'generated') {
          regenerated++
          console.log(`  ✓ "${o.title}" ${result.beatCount} beats (${result.generationMode})`)
        } else {
          regenSkipped++
          console.log(`  - "${o.title}" ${result.status}`)
        }
        await invalidateFilmCache(o.filmId).catch(() => {})
      } catch (err) {
        regenFailed++
        console.error(`  ✗ "${o.title}": ${err instanceof Error ? err.message : String(err)}`)
      }
      await new Promise((r) => setTimeout(r, REGEN_GAP_MS))
    }
  }

  console.log('\n=== DONE ===')
  console.log(`  runtimes fixed:          ${fixed} of ${fixable.length}`)
  console.log(`  graphs regenerated:      ${regenerated}  (skipped ${regenSkipped}, failed ${regenFailed})`)
  console.log(`  films left without runtime: ${outcomes.length - fixable.length}  (listed above)`)
  await prisma.$disconnect()
  if (regenFailed > 0) process.exit(2)
}

main().catch(async (err) => {
  console.error('Fatal:', err)
  try {
    await prisma.$disconnect()
  } catch {
    // ignore
  }
  process.exit(1)
})
