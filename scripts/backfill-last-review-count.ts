/**
 * One-off backfill: populate Film.lastReviewCount for legacy films whose
 * SentimentGraph exists but whose lastReviewCount is still 0.
 *
 * Background: older pipeline runs stored a SentimentGraph without writing
 * back lastReviewCount. That leaves those films stuck on the
 * "Legacy film, no lastReviewCount" branch of filmNeedsReanalysis(), so
 * they get re-prepped by the weekly cron every cycle even when their
 * reviews haven't changed. Writing the current quality-review count into
 * lastReviewCount lets the normal ≥10% growth threshold take over.
 *
 * Idempotent — targets only rows where lastReviewCount = 0, so a second
 * run (after a successful first run) finds nothing to do.
 *
 * Usage: npx tsx scripts/backfill-last-review-count.ts
 */
import 'dotenv/config'
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import { prisma } from '../src/lib/prisma'
import { isQualityReview } from '../src/lib/sentiment-pipeline'

async function main() {
  const films = await prisma.film.findMany({
    where: { lastReviewCount: 0, sentimentGraph: { isNot: null } },
    select: { id: true, title: true },
    orderBy: { title: 'asc' },
  })

  const total = films.length
  console.log(`Found ${total} films to backfill (lastReviewCount=0 with existing SentimentGraph).`)
  if (total === 0) {
    console.log('Nothing to do. Exiting.')
    await prisma.$disconnect()
    return
  }

  let updated = 0
  let failed = 0

  for (let i = 0; i < films.length; i++) {
    const film = films[i]
    try {
      const reviews = await prisma.review.findMany({
        where: { filmId: film.id },
        select: { reviewText: true },
      })
      const qualityCount = reviews.filter((r) => isQualityReview(r.reviewText)).length

      await prisma.film.update({
        where: { id: film.id },
        data: { lastReviewCount: qualityCount },
      })
      updated++
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  FAILED: ${film.title} (${film.id}) — ${message}`)
    }

    if ((i + 1) % 10 === 0) {
      console.log(`Processed ${i + 1} of ${total}`)
    }
  }

  console.log(`Backfilled lastReviewCount for ${updated} films`)
  if (failed > 0) {
    console.log(`Skipped ${failed} films due to errors (see logs above).`)
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
