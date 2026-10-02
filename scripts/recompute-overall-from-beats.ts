/**
 * One-shot: make every SentimentGraph's overallScore the mean of its beat
 * scores, rounded to one decimal, the same derivation the write path now
 * applies (overallScoreFromBeats in src/lib/sentiment-guards.ts).
 *
 * For each row whose stored overallScore differs from that mean:
 *   previousScore <- current overallScore
 *   overallScore  <- round1(mean(dataPoints[].score))
 *   arcShape      <- classifyArcShape(dataPoints, new overallScore)
 * then the film's cache keys are invalidated. Rows already equal to the mean
 * are left completely untouched, so an earlier genuine previousScore delta on
 * a consistent row is not wiped. The homepage cache is invalidated once at
 * the end because its sections order by overallScore.
 *
 * Writes are optimistic: UPDATE ... WHERE id = ? AND overallScore = <value
 * read>, so a row changed underneath by the cron is skipped and reported
 * rather than clobbered. dataPoints are never modified.
 *
 * --expect-host <substring> is REQUIRED for both modes. The script prints the
 * database host (credentials stripped) and aborts before any read when the
 * host does not contain the substring. Production is `plain-shadow`.
 *
 * Usage:
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/recompute-overall-from-beats.ts --dry-run --expect-host plain-shadow
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/recompute-overall-from-beats.ts --commit  --expect-host plain-shadow
 *
 * --dry-run reads only: prints how many rows would change, how many are
 * already consistent, how many have no usable beats, and the 10 largest
 * before/after changes. No writes, no cache invalidation.
 */
import './_load-env'
import './_neon-ws'

import { prisma } from '../src/lib/prisma'
import { overallScoreFromBeats } from '../src/lib/sentiment-guards'
import { classifyArcShape } from '../src/lib/arc-classifier'
import { invalidateFilmCache, invalidateHomepageCache } from '../src/lib/cache'
import type { SentimentDataPoint } from '../src/lib/types'

const SAMPLE_COUNT = 10
const PROGRESS_EVERY = 200

interface Args {
  dryRun: boolean
  commit: boolean
  expectHost: string
}

interface Change {
  graphId: string
  filmId: string
  title: string
  before: number
  after: number
  arcShape: string[]
}

function parseArgs(argv: string[]): Args {
  let dryRun = false
  let commit = false
  let expectHost: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--commit') commit = true
    else if (a === '--expect-host') {
      expectHost = argv[++i] ?? null
      if (!expectHost) throw new Error('--expect-host requires a substring')
    } else throw new Error(`Unknown argument: ${a}`)
  }
  if (!dryRun && !commit) throw new Error('Must pass --dry-run or --commit')
  if (dryRun && commit) throw new Error('Cannot pass both --dry-run and --commit')
  if (!expectHost) throw new Error('--expect-host <substring> is required (production is plain-shadow)')
  return { dryRun, commit, expectHost }
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const host = databaseHost()
  console.log(`[db] host=${host}`)
  if (!host.includes(args.expectHost)) {
    console.error(`[db] host does not contain "${args.expectHost}"; aborting before any read or write`)
    process.exit(1)
  }
  console.log(`recompute-overall-from-beats: ${args.dryRun ? 'DRY RUN (no writes)' : 'COMMIT'}`)

  const graphs = await prisma.sentimentGraph.findMany({
    select: {
      id: true,
      filmId: true,
      overallScore: true,
      previousScore: true,
      dataPoints: true,
      film: { select: { title: true } },
    },
    orderBy: { filmId: 'asc' },
  })
  console.log(`Loaded ${graphs.length} sentiment graphs`)

  const changes: Change[] = []
  let unchanged = 0
  const noBeats: { graphId: string; title: string; reason: string }[] = []

  for (const g of graphs) {
    const beats = Array.isArray(g.dataPoints) ? (g.dataPoints as unknown as SentimentDataPoint[]) : []
    if (beats.length === 0) {
      noBeats.push({ graphId: g.id, title: g.film.title, reason: 'no dataPoints' })
      continue
    }
    let after: number
    try {
      after = overallScoreFromBeats(beats)
    } catch (err) {
      noBeats.push({ graphId: g.id, title: g.film.title, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (after === g.overallScore) {
      unchanged++
      continue
    }
    changes.push({
      graphId: g.id,
      filmId: g.filmId,
      title: g.film.title,
      before: g.overallScore,
      after,
      arcShape: classifyArcShape(beats, after),
    })
  }

  const deltas = changes.map((c) => Math.abs(c.after - c.before)).sort((a, b) => a - b)
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0

  console.log('\n=== SUMMARY ===')
  console.log(`  rows that change:       ${changes.length}`)
  console.log(`  already consistent:     ${unchanged}  (untouched)`)
  console.log(`  no usable beats:        ${noBeats.length}  (untouched)`)
  if (deltas.length) {
    console.log(`  |delta| median / max:   ${median.toFixed(1)} / ${deltas[deltas.length - 1].toFixed(1)}`)
    console.log(`  score goes up / down:   ${changes.filter((c) => c.after > c.before).length} / ${changes.filter((c) => c.after < c.before).length}`)
  }
  for (const n of noBeats) console.log(`    skip ${n.graphId} "${n.title}": ${n.reason}`)

  const samples = [...changes].sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)).slice(0, SAMPLE_COUNT)
  console.log(`\n=== ${samples.length} LARGEST CHANGES (before -> after) ===`)
  for (const s of samples) {
    const delta = s.after - s.before
    console.log(`  ${s.before.toFixed(1)} -> ${s.after.toFixed(1)}  (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})  "${s.title}"  ${s.filmId}`)
  }

  if (args.dryRun) {
    console.log('\nDry run complete. No writes, no cache invalidation.')
    await prisma.$disconnect()
    return
  }

  console.log(`\nApplying ${changes.length} updates...`)
  let written = 0
  let skippedChangedUnderneath = 0
  let failed = 0
  let cacheFailures = 0

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]
    try {
      // Optimistic: only if the row still carries the value we read.
      const result = await prisma.sentimentGraph.updateMany({
        where: { id: c.graphId, overallScore: c.before },
        data: { previousScore: c.before, overallScore: c.after, arcShape: c.arcShape },
      })
      if (result.count === 0) {
        skippedChangedUnderneath++
        console.log(`  ~ ${c.graphId} "${c.title}" changed underneath (overallScore no longer ${c.before}); skipped`)
      } else {
        written++
        try {
          await invalidateFilmCache(c.filmId)
        } catch (err) {
          cacheFailures++
          console.warn(`  [cache] invalidate failed for ${c.filmId}: ${err instanceof Error ? err.message : err}`)
        }
      }
    } catch (err) {
      failed++
      console.error(`  ✗ ${c.graphId} "${c.title}": ${err instanceof Error ? err.message : String(err)}`)
    }
    if ((i + 1) % PROGRESS_EVERY === 0) console.log(`  ${i + 1}/${changes.length}`)
  }

  try {
    await invalidateHomepageCache()
  } catch (err) {
    cacheFailures++
    console.warn(`  [cache] homepage invalidate failed: ${err instanceof Error ? err.message : err}`)
  }

  console.log('\n=== DONE ===')
  console.log(`  written:                ${written}`)
  console.log(`  changed underneath:     ${skippedChangedUnderneath}`)
  console.log(`  failed:                 ${failed}`)
  console.log(`  cache invalidations failed: ${cacheFailures}`)
  console.log('  Verify with scripts/sql/graph-mean-distribution.sql: over_tolerance should be 0.')

  await prisma.$disconnect()
  if (failed > 0) process.exit(2)
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
