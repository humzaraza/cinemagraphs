/**
 * Read-only diagnostic: measure how stale SentimentGraph.reviewCount is
 * relative to the live quality-filtered Review count per film.
 * Written during 3d.3 sentiment graph threshold alignment (April 2026).
 *
 * Applies the SAME quality filter the pipeline uses by importing
 * `isQualityReview` from src/lib/sentiment-pipeline.ts, no approximation.
 *
 * Usage: npx tsx scripts/diagnostic/reviewcount-staleness.ts
 */
import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: ['.env.local', '.env'] })
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

const BATCH_SIZE = 25

interface PerFilm {
  filmId: string
  title: string
  storedCount: number
  liveCount: number
  rawReviewCount: number
  delta: number
}

async function main() {
  const { prisma } = await import('../../src/lib/prisma')
  const { isQualityReview } = await import('../../src/lib/sentiment-pipeline')

  const graphs = await prisma.sentimentGraph.findMany({
    select: {
      filmId: true,
      reviewCount: true,
      film: { select: { title: true } },
    },
  })

  console.log(`Computing live quality-review counts for ${graphs.length} films...`)
  const startedAt = Date.now()

  const results: PerFilm[] = []
  for (let i = 0; i < graphs.length; i += BATCH_SIZE) {
    const batch = graphs.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async (g) => {
        const reviews = await prisma.review.findMany({
          where: { filmId: g.filmId },
          select: { reviewText: true },
        })
        const liveCount = reviews.filter((r) => isQualityReview(r.reviewText)).length
        return {
          filmId: g.filmId,
          title: g.film.title,
          storedCount: g.reviewCount,
          liveCount,
          rawReviewCount: reviews.length,
          delta: liveCount - g.reviewCount,
        } satisfies PerFilm
      }),
    )
    results.push(...batchResults)
    if ((i + BATCH_SIZE) % 200 === 0 || i + BATCH_SIZE >= graphs.length) {
      const done = Math.min(i + BATCH_SIZE, graphs.length)
      const pct = ((done / graphs.length) * 100).toFixed(0)
      console.log(`  progress: ${done}/${graphs.length} (${pct}%)`)
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`  done in ${elapsedSec}s\n`)

  // ── a/b/c: delta sign buckets ──────────────────────────────────────────
  const deltaZero = results.filter((r) => r.delta === 0).length
  const deltaPos = results.filter((r) => r.delta > 0).length
  const deltaNeg = results.filter((r) => r.delta < 0).length

  console.log('='.repeat(72))
  console.log('Delta sign buckets  (delta = liveCount - storedCount)')
  console.log('='.repeat(72))
  console.log(`  delta == 0 (snapshot matches reality):  ${deltaZero}`)
  console.log(`  delta >  0 (reviews arrived since):     ${deltaPos}`)
  console.log(`  delta <  0 (reviews removed since):     ${deltaNeg}`)

  // ── d: positive-delta distribution ─────────────────────────────────────
  const posDeltas = results.filter((r) => r.delta > 0).map((r) => r.delta)
  const bucket = (lo: number, hi: number) =>
    posDeltas.filter((d) => d >= lo && d <= hi).length
  const b1 = bucket(1, 1)
  const b2 = bucket(2, 2)
  const b3_5 = bucket(3, 5)
  const b6_10 = bucket(6, 10)
  const b11_plus = posDeltas.filter((d) => d >= 11).length

  console.log('')
  console.log('='.repeat(72))
  console.log('Positive delta distribution')
  console.log('='.repeat(72))
  console.log(`  delta = +1:      ${b1}`)
  console.log(`  delta = +2:      ${b2}`)
  console.log(`  delta = +3..+5:  ${b3_5}`)
  console.log(`  delta = +6..+10: ${b6_10}`)
  console.log(`  delta = +11+:    ${b11_plus}`)

  // ── e: false-negatives in the storedCount < 5 pool ─────────────────────
  const underFive = results.filter((r) => r.storedCount < 5)
  const underFiveButLiveAtLeast5 = underFive.filter((r) => r.liveCount >= 5)

  console.log('')
  console.log('='.repeat(72))
  console.log('False-negatives (display gate hides graphs that now qualify)')
  console.log('='.repeat(72))
  console.log(`  pool (storedCount < 5):               ${underFive.length}`)
  console.log(`  of those with liveCount >= 5:         ${underFiveButLiveAtLeast5.length}`)
  if (underFiveButLiveAtLeast5.length > 0) {
    console.log(`  (these films currently show "Not enough reviews" but the live`)
    console.log(`   quality-review count has grown past the display threshold)`)
  }

  // ── f: top 10 positive deltas ──────────────────────────────────────────
  const top10 = [...results]
    .filter((r) => r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 10)

  console.log('')
  console.log('='.repeat(72))
  console.log('Top 10 positive deltas')
  console.log('='.repeat(72))
  if (top10.length === 0) {
    console.log('  (no positive deltas)')
  } else {
    for (const r of top10) {
      console.log(
        `  +${r.delta}  ${r.title}  [stored=${r.storedCount}, live=${r.liveCount}, rawReviews=${r.rawReviewCount}]`,
      )
      console.log(`       filmId: ${r.filmId}`)
    }
  }

  // Reference confirmation for the Good Luck case the user called out.
  const gl = results.find((r) => r.filmId === 'cmn70iegv007vlfeerzi1lywi')
  if (gl) {
    console.log('')
    console.log('='.repeat(72))
    console.log('Reference: Good Luck, Have Fun, Don\'t Die')
    console.log('='.repeat(72))
    console.log(
      `  storedCount=${gl.storedCount}  liveCount=${gl.liveCount}  rawReviewCount=${gl.rawReviewCount}  delta=${gl.delta}`,
    )
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
