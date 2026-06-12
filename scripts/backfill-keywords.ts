/**
 * Backfill TMDB keywords for films that have none.
 *
 * Place in the import tail sequence: runs after the studio bulk import
 * completes, BEFORE backfill-persons.ts and backfill-similar-films.ts, so the
 * similar-films recompute does not rebake keyword-degraded edges. Requires
 * TMDB live (TMDB_API_KEY).
 *
 * Selects only films whose keywords array is empty; films with non-empty
 * keywords are never touched. If TMDB has no keywords for a film, nothing is
 * written, so re-running re-checks those films. Films that gained keywords on
 * a prior run no longer match the selector, which makes the script idempotent
 * and naturally resumable.
 *
 * Usage:
 *   npx tsx scripts/backfill-keywords.ts [--dry-run] [--limit N]
 *
 *   --dry-run   fetch and report, write nothing
 *   --limit N   process at most N films (small first run)
 */
import './_load-env'
import './_neon-ws'
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { getMovieKeywords } from '../src/lib/tmdb'

if (!process.env.TMDB_API_KEY) {
  console.error('TMDB_API_KEY not found in environment')
  process.exit(1)
}

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

// Same delay convention as the sequential TMDB calls in bulk-import-tmdb.ts.
const RATE_LIMIT_DELAY_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(): { dryRun: boolean; limit: number | undefined } {
  const dryRun = process.argv.includes('--dry-run')
  let limit: number | undefined
  const limitIdx = process.argv.indexOf('--limit')
  if (limitIdx !== -1) {
    limit = Number(process.argv[limitIdx + 1])
    if (!Number.isInteger(limit) || limit <= 0) {
      console.error('Usage: npx tsx scripts/backfill-keywords.ts [--dry-run] [--limit N]')
      process.exit(1)
    }
  }
  return { dryRun, limit }
}

async function main() {
  const { dryRun, limit } = parseArgs()
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'live'}${limit ? `, limit ${limit}` : ''}\n`)

  // tmdbId is non-nullable (Int @unique) in the schema, so a film without one
  // cannot exist; no skip path is needed for that case.
  const films = await prisma.film.findMany({
    where: { keywords: { isEmpty: true } },
    select: { id: true, title: true, tmdbId: true },
    orderBy: { title: 'asc' },
    ...(limit ? { take: limit } : {}),
  })
  console.log(`Films with empty keywords selected: ${films.length}\n`)

  let gained = 0
  let tmdbHasNone = 0
  const errors: string[] = []

  for (let i = 0; i < films.length; i++) {
    const film = films[i]
    const n = `[${i + 1}/${films.length}]`
    try {
      const keywords = await getMovieKeywords(film.tmdbId)
      if (keywords.length === 0) {
        tmdbHasNone++
        console.log(`${n} ${film.title}: TMDB has none`)
      } else {
        if (!dryRun) {
          await prisma.film.update({ where: { id: film.id }, data: { keywords } })
        }
        gained++
        console.log(`${n} ${film.title}: ${keywords.length} keywords${dryRun ? ' (not written)' : ''}`)
      }
    } catch (err) {
      errors.push(`${film.title} (tmdbId=${film.tmdbId}): ${err}`)
      console.error(`${n} ✗ ${film.title}: ${err}`)
    }

    if (i < films.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS)
    }
  }

  console.log('\n═══════════════════════════════════════════')
  console.log(`     KEYWORDS BACKFILL ${dryRun ? 'DRY RUN ' : ''}COMPLETE`)
  console.log('═══════════════════════════════════════════')
  console.log(`Total selected:      ${films.length}`)
  console.log(`Gained keywords:     ${gained}${dryRun ? ' (dry run, nothing written)' : ''}`)
  console.log(`TMDB has none:       ${tmdbHasNone}`)
  console.log(`Errors:              ${errors.length}`)
  if (errors.length > 0) {
    console.log('\nFailed films (skipped, re-run to retry):')
    errors.forEach((e) => console.log(`  - ${e}`))
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
