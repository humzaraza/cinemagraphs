/**
 * One-time batch: generate sentiment graphs for all films missing them.
 * Pre-checks review threshold before calling Claude API to avoid wasting tokens.
 *
 * Usage: npx tsx scripts/batch-generate.ts
 * Requires: ws dev dependency for local Neon DB connection.
 */
import 'dotenv/config'
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket
import { prisma } from '../src/lib/prisma'
import { fetchReviewsAndCheckThreshold, generateSentimentGraph } from '../src/lib/sentiment-pipeline'

const DELAY_MS = 3000

async function main() {
  console.log('=== BATCH GENERATE SENTIMENT GRAPHS ===\n')

  const films = await prisma.film.findMany({
    where: {
      status: 'ACTIVE',
      sentimentGraph: { is: null },
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`Found ${films.length} films without sentiment graphs\n`)

  if (films.length === 0) {
    console.log('Nothing to do.')
    await prisma.$disconnect()
    return
  }

  let generated = 0
  let skipped = 0
  let failed = 0
  const skippedFilms: string[] = []
  const failedFilms: string[] = []

  for (let i = 0; i < films.length; i++) {
    const film = films[i]
    const tag = `[${i + 1}/${films.length}]`

    try {
      // Step 1: Fetch reviews and check threshold (no Claude API cost)
      const check = await fetchReviewsAndCheckThreshold(film.id)

      if (!check.meetsThreshold) {
        console.log(`${tag} SKIP  ${film.title} — ${check.qualityCount} quality reviews, need ${check.minRequired}`)
        skippedFilms.push(film.title)
        skipped++
      } else {
        // Step 2: Generate graph (calls Claude API)
        console.log(`${tag} GEN   ${film.title} — ${check.qualityCount} quality reviews, generating...`)
        await generateSentimentGraph(film.id)
        console.log(`${tag} OK    ${film.title}`)
        generated++
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`${tag} FAIL  ${film.title} — ${msg}`)
      failedFilms.push(`${film.title}: ${msg}`)
      failed++
    }

    // Delay between films to avoid rate limits
    if (i < films.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    }
  }

  console.log('\n=== RESULTS ===')
  console.log(`Generated: ${generated}`)
  console.log(`Skipped:   ${skipped} (insufficient reviews)`)
  console.log(`Failed:    ${failed}`)
  console.log(`Total:     ${films.length}`)

  if (skippedFilms.length > 0) {
    console.log(`\nSkipped films:`)
    skippedFilms.forEach((t) => console.log(`  - ${t}`))
  }
  if (failedFilms.length > 0) {
    console.log(`\nFailed films:`)
    failedFilms.forEach((t) => console.log(`  - ${t}`))
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
