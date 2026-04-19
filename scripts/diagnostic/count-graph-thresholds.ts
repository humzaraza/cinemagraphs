/**
 * Read-only diagnostic: count SentimentGraph rows across reviewCount bands and
 * break the <5 pool down by release-age. Used to size the blast radius before
 * any threshold-alignment decision.
 * Written during 3d.3 sentiment graph threshold alignment (April 2026).
 *
 * Usage: npx tsx scripts/diagnostic/count-graph-thresholds.ts
 */
import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: ['.env.local', '.env'] })
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

const MS_PER_DAY = 24 * 60 * 60 * 1000
const RECENT_RELEASE_DAYS = 180

async function main() {
  const { prisma } = await import('../../src/lib/prisma')

  const now = new Date()
  const recentBoundary = new Date(now.getTime() - RECENT_RELEASE_DAYS * MS_PER_DAY)

  // Totals across bands (using Prisma count so we aren't loading rows we
  // don't need to).
  const [total, lt3, lt5, lt10] = await Promise.all([
    prisma.sentimentGraph.count(),
    prisma.sentimentGraph.count({ where: { reviewCount: { lt: 3 } } }),
    prisma.sentimentGraph.count({ where: { reviewCount: { lt: 5 } } }),
    prisma.sentimentGraph.count({ where: { reviewCount: { lt: 10 } } }),
  ])

  console.log('='.repeat(72))
  console.log('SentimentGraph reviewCount distribution')
  console.log('='.repeat(72))
  console.log(`  total:               ${total}`)
  console.log(`  reviewCount < 3:     ${lt3}   (${pct(lt3, total)})`)
  console.log(`  reviewCount < 5:     ${lt5}   (${pct(lt5, total)})`)
  console.log(`  reviewCount < 10:    ${lt10}   (${pct(lt10, total)})`)

  // Release-age breakdown for the <5 pool. Pull the rows with the film's
  // releaseDate joined so we can bucket in JS.
  const underFive = await prisma.sentimentGraph.findMany({
    where: { reviewCount: { lt: 5 } },
    select: {
      filmId: true,
      reviewCount: true,
      overallScore: true,
      sourcesUsed: true,
      film: {
        select: { title: true, releaseDate: true },
      },
    },
  })

  let preRelease = 0
  let recent = 0
  let older = 0
  let unknownDate = 0
  for (const g of underFive) {
    const d = g.film.releaseDate
    if (!d) {
      unknownDate++
      continue
    }
    if (d > now) preRelease++
    else if (d > recentBoundary) recent++
    else older++
  }

  console.log('')
  console.log('='.repeat(72))
  console.log('reviewCount < 5 — release-age breakdown')
  console.log('='.repeat(72))
  console.log(`  pool size:                        ${underFive.length}`)
  console.log(`  pre-release (releaseDate > now):  ${preRelease}`)
  console.log(`  recent (within last ${RECENT_RELEASE_DAYS} days):       ${recent}`)
  console.log(`  older (> ${RECENT_RELEASE_DAYS} days):                  ${older}`)
  if (unknownDate > 0) {
    console.log(`  unknown (no releaseDate):         ${unknownDate}`)
  }

  // Sample 5 films from the <5 pool.
  console.log('')
  console.log('='.repeat(72))
  console.log('Sample (first 5 of reviewCount < 5 pool)')
  console.log('='.repeat(72))
  const sample = underFive.slice(0, 5)
  if (sample.length === 0) {
    console.log('  (empty pool)')
  } else {
    for (const g of sample) {
      console.log(`  - ${g.film.title}`)
      console.log(`      filmId:       ${g.filmId}`)
      console.log(`      reviewCount:  ${g.reviewCount}`)
      console.log(`      overallScore: ${g.overallScore}`)
      console.log(`      releaseDate:  ${g.film.releaseDate?.toISOString() ?? '(null)'}`)
      console.log(`      sourcesUsed:  [${(g.sourcesUsed ?? []).join(', ')}]`)
    }
  }

  await prisma.$disconnect()
}

function pct(n: number, d: number): string {
  if (d === 0) return '0%'
  return `${((n / d) * 100).toFixed(1)}%`
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
