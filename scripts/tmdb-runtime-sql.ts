/**
 * Step 2 helper: look each film from the runtime audit up on TMDB and print a
 * ready-to-paste UPDATE for the Neon console.
 *
 * Touches NO database. The only network calls are GET /movie/{tmdbId} on TMDB
 * (TMDB_API_KEY from .env.local). Input is the STEP 2a result of
 * scripts/sql/film-runtime-audit.sql, exported from the console as CSV or
 * JSON, or a bare list of ids.
 *
 * Buckets:
 *   fixable              TMDB reports runtime > 0             -> in the UPDATE
 *   unreleased           no runtime and TMDB status is not "Released", or the
 *                        release date is missing or in the future -> listed, untouched
 *   released_no_runtime  TMDB says Released but has no runtime -> listed, untouched
 *   error                TMDB lookup failed                    -> listed, untouched
 *
 * Nothing is guessed. Only a positive runtime read from TMDB is ever emitted.
 *
 * Usage:
 *   npx tsx scripts/tmdb-runtime-sql.ts --ids 550,603,27205
 *   npx tsx scripts/tmdb-runtime-sql.ts --file runtime-audit.csv
 *   npx tsx scripts/tmdb-runtime-sql.ts --file runtime-audit.json
 *   npx tsx scripts/tmdb-runtime-sql.ts --file runtime-audit.csv --out runtime-fix.sql
 */
import './_load-env'

import fs from 'node:fs'

const TMDB_API_KEY = process.env.TMDB_API_KEY
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'
const REQUEST_GAP_MS = 60

interface TmdbMovie {
  id: number
  title?: string
  runtime?: number | null
  status?: string
  release_date?: string
}

type Bucket = 'fixable' | 'unreleased' | 'released_no_runtime' | 'error'

interface Outcome {
  tmdbId: number
  bucket: Bucket
  title?: string
  runtime?: number
  status?: string
  releaseDate?: string
  error?: string
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { ids: number[]; out: string | null } {
  let ids: number[] = []
  let out: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--ids') {
      const raw = argv[++i]
      if (!raw) throw new Error('--ids requires a comma-separated list of tmdbIds')
      ids = ids.concat(raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))
    } else if (a === '--file') {
      const file = argv[++i]
      if (!file) throw new Error('--file requires a path')
      ids = ids.concat(readIdsFromFile(file))
    } else if (a === '--out') {
      out = argv[++i] ?? null
      if (!out) throw new Error('--out requires a path')
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }
  const unique = [...new Set(ids)]
  if (unique.length === 0) throw new Error('No tmdbIds supplied. Pass --ids or --file.')
  return { ids: unique, out }
}

function readIdsFromFile(file: string): number[] {
  const raw = fs.readFileSync(file, 'utf8')
  const trimmed = raw.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>).tmdbId : undefined))
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0)
  }
  const table = parseCsv(trimmed)
  if (table.length === 0) return []
  const header = table[0].map((h) => h.trim())
  const col = header.findIndex((h) => h === 'tmdbId' || h === '"tmdbId"')
  if (col === -1) throw new Error(`CSV has no tmdbId column (header: ${header.join(', ')})`)
  return table
    .slice(1)
    .map((row) => Number(row[col]))
    .filter((n) => Number.isInteger(n) && n > 0)
}

// Minimal RFC-4180 reader: handles quoted fields, embedded commas, doubled
// quotes, and CRLF. Titles with commas are the reason a naive split will not do.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// ── TMDB ─────────────────────────────────────────────────────────────────────

async function fetchMovie(tmdbId: number): Promise<TmdbMovie> {
  const res = await fetch(`${TMDB_BASE_URL}/movie/${tmdbId}`, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
  })
  if (!res.ok) throw new Error(`TMDB ${res.status} ${res.statusText}`)
  return (await res.json()) as TmdbMovie
}

function classify(tmdbId: number, movie: TmdbMovie, today: string): Outcome {
  const base = {
    tmdbId,
    title: movie.title,
    status: movie.status,
    releaseDate: movie.release_date || undefined,
  }
  const runtime = movie.runtime
  if (typeof runtime === 'number' && Number.isInteger(runtime) && runtime > 0) {
    return { ...base, bucket: 'fixable', runtime }
  }
  const releaseMissing = !movie.release_date
  const releaseInFuture = Boolean(movie.release_date && movie.release_date > today)
  const notReleased = movie.status !== 'Released'
  if (notReleased || releaseMissing || releaseInFuture) {
    return { ...base, bucket: 'unreleased' }
  }
  return { ...base, bucket: 'released_no_runtime' }
}

// ── Output ───────────────────────────────────────────────────────────────────

function sqlComment(s: string | undefined): string {
  return (s ?? '').replace(/[\r\n]+/g, ' ').replace(/--/g, '- -')
}

function buildUpdateSql(fixable: Outcome[]): string {
  if (fixable.length === 0) return '-- No fixable rows: nothing to UPDATE.\n'
  const values = fixable
    .map((o, i) => `  (${o.tmdbId}, ${o.runtime})${i < fixable.length - 1 ? ',' : ''}  -- ${sqlComment(o.title)}`)
    .join('\n')
  return [
    '-- Generated by scripts/tmdb-runtime-sql.ts. Runtimes are TMDB values, unmodified.',
    '-- Guards: only rows still at NULL/<=0 are touched; only positive values written.',
    'UPDATE "Film" AS f',
    'SET runtime     = v.runtime,',
    '    "updatedAt" = now()',
    'FROM (VALUES',
    values,
    ') AS v("tmdbId", runtime)',
    'WHERE f."tmdbId" = v."tmdbId"',
    '  AND (f.runtime IS NULL OR f.runtime <= 0)',
    '  AND v.runtime > 0',
    'RETURNING f."tmdbId", f.title, f.runtime;',
    '',
  ].join('\n')
}

function printBucket(label: string, items: Outcome[]): void {
  console.log(`\n${label} (${items.length}):`)
  for (const o of items) {
    const bits = [
      `tmdbId=${o.tmdbId}`,
      `"${o.title ?? '?'}"`,
      o.status ? `status=${o.status}` : null,
      o.releaseDate ? `release=${o.releaseDate}` : 'release=none',
      o.error ? `error=${o.error}` : null,
    ].filter(Boolean)
    console.log(`  ${bits.join('  ')}`)
  }
}

async function main() {
  const { ids, out } = parseArgs(process.argv.slice(2))
  if (!TMDB_API_KEY) {
    console.error('TMDB_API_KEY is not set in .env.local')
    process.exit(1)
  }
  const today = new Date().toISOString().slice(0, 10)
  console.log(`Looking up ${ids.length} tmdbIds on TMDB (${TMDB_BASE_URL})...`)

  const outcomes: Outcome[] = []
  for (const tmdbId of ids) {
    try {
      const movie = await fetchMovie(tmdbId)
      outcomes.push(classify(tmdbId, movie, today))
    } catch (err) {
      outcomes.push({ tmdbId, bucket: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    await new Promise((r) => setTimeout(r, REQUEST_GAP_MS))
  }

  const by = (b: Bucket) => outcomes.filter((o) => o.bucket === b)
  const fixable = by('fixable')
  const sql = buildUpdateSql(fixable)

  console.log('\n=== SUMMARY ===')
  console.log(`  fixable (in UPDATE):   ${fixable.length}`)
  console.log(`  unreleased (left):     ${by('unreleased').length}`)
  console.log(`  released_no_runtime:   ${by('released_no_runtime').length}`)
  console.log(`  error:                 ${by('error').length}`)

  printBucket('FIXABLE', fixable.map((o) => ({ ...o, title: `${o.title} -> ${o.runtime} min` })))
  printBucket('UNRELEASED (no runtime on TMDB; left alone, do not guess)', by('unreleased'))
  printBucket('RELEASED BUT TMDB HAS NO RUNTIME (left alone, do not guess)', by('released_no_runtime'))
  printBucket('LOOKUP ERRORS (left alone)', by('error'))

  console.log('\n=== SQL (paste into the Neon console) ===\n')
  console.log(sql)
  if (out) {
    fs.writeFileSync(out, sql)
    console.log(`Wrote ${out}`)
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
