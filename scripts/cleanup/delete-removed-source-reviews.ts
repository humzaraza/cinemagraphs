/**
 * Delete stored reviews from the three sources that were removed from the
 * pipeline: CRITIC_BLOG (Roger Ebert), LETTERBOXD, and REDDIT.
 *
 * The fetchers are gone, but rows collected before that are still in the
 * Review table and are still read by every generation path. Deleting them
 * means they never feed a graph again. Only Review rows with those three
 * sourcePlatform values are touched: no graph, film, or user review changes.
 *
 * Run scripts/reword-copied-passages.ts FIRST. A stored summary that copies
 * one of these reviews can only be detected while the review still exists.
 *
 * After deletion a film's stored quality-review count can drop. Existing
 * graphs stay as they are; the dry run reports how many films with a graph
 * would fall below the 3 quality reviews a regeneration needs.
 *
 * --dry-run prints the counts and makes no change. --expect-host is required.
 *
 * Usage:
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/cleanup/delete-removed-source-reviews.ts --dry-run --expect-host plain-shadow
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/cleanup/delete-removed-source-reviews.ts --commit  --expect-host plain-shadow
 */
import '../_load-env'
import '../_neon-ws'

import { prisma } from '../../src/lib/prisma'
import { isQualityReview } from '../../src/lib/sentiment-pipeline'
import { MIN_QUALITY_REVIEWS } from '../../src/lib/hybrid-sentiment'

const REMOVED_SOURCES = ['CRITIC_BLOG', 'LETTERBOXD', 'REDDIT'] as const
const KEPT_SOURCES = ['TMDB', 'IMDB', 'GUARDIAN'] as const

function parseArgs(argv: string[]): { dryRun: boolean; commit: boolean; expectHost: string } {
  let dryRun = false
  let commit = false
  let expectHost: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--commit') commit = true
    else if (a === '--expect-host') expectHost = argv[++i] ?? null
    else throw new Error(`Unknown argument: ${a}`)
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
  console.log(`delete-removed-source-reviews: ${args.dryRun ? 'DRY RUN (no writes)' : 'COMMIT'}`)

  const counts = await prisma.review.groupBy({ by: ['sourcePlatform'], _count: { _all: true } })
  const countOf = (p: string) => counts.find((c) => c.sourcePlatform === p)?._count._all ?? 0
  const toDelete = REMOVED_SOURCES.reduce((n, p) => n + countOf(p), 0)

  console.log('\n=== STORED REVIEWS BY SOURCE ===')
  for (const p of REMOVED_SOURCES) console.log(`  ${p.padEnd(12)} ${String(countOf(p)).padStart(7)}   to delete`)
  for (const p of KEPT_SOURCES) console.log(`  ${p.padEnd(12)} ${String(countOf(p)).padStart(7)}   kept`)
  console.log(`  total to delete: ${toDelete}`)

  // Which films are affected, and which would drop below the regeneration
  // minimum once these reviews are gone.
  const affected = await prisma.review.findMany({
    where: { sourcePlatform: { in: [...REMOVED_SOURCES] } },
    select: { filmId: true },
    distinct: ['filmId'],
  })
  const affectedIds = affected.map((r) => r.filmId)
  let withGraph = 0
  const belowMinimum: string[] = []
  for (let offset = 0; offset < affectedIds.length; offset += 200) {
    const ids = affectedIds.slice(offset, offset + 200)
    const films = await prisma.film.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        title: true,
        sentimentGraph: { select: { id: true } },
        reviews: { select: { sourcePlatform: true, reviewText: true } },
      },
    })
    for (const f of films) {
      if (!f.sentimentGraph) continue
      withGraph++
      const remaining = f.reviews.filter(
        (r) => !(REMOVED_SOURCES as readonly string[]).includes(r.sourcePlatform) && isQualityReview(r.reviewText)
      ).length
      if (remaining < MIN_QUALITY_REVIEWS) belowMinimum.push(`${f.title} (${remaining} left)`)
    }
  }

  console.log('\n=== EFFECT ===')
  console.log(`  films holding such reviews:                 ${affectedIds.length}`)
  console.log(`  of those, films with a graph:               ${withGraph}`)
  console.log(`  graphs left with fewer than ${MIN_QUALITY_REVIEWS} quality reviews: ${belowMinimum.length}  (graph stays; cannot be regenerated until more reviews arrive)`)
  for (const t of belowMinimum.slice(0, 25)) console.log(`     ${t}`)
  if (belowMinimum.length > 25) console.log(`     ... and ${belowMinimum.length - 25} more`)

  if (args.dryRun) {
    console.log('\nDry run complete. Nothing was deleted.')
    await prisma.$disconnect()
    return
  }

  const result = await prisma.review.deleteMany({ where: { sourcePlatform: { in: [...REMOVED_SOURCES] } } })
  const after = await prisma.review.count({ where: { sourcePlatform: { in: [...REMOVED_SOURCES] } } })
  console.log('\n=== DONE ===')
  console.log(`  deleted:   ${result.count} review rows`)
  console.log(`  remaining from removed sources: ${after}`)
  await prisma.$disconnect()
  if (after !== 0) process.exit(2)
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
