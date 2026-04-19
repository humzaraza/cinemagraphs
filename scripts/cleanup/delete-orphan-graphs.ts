/**
 * Delete SentimentGraph rows with reviewCount < 3 (orphan graphs from the
 * pre-alignment era). Related Film, Review, and UserReview records are
 * preserved. Affected films will regenerate graphs naturally once they
 * accumulate 3+ quality reviews.
 *
 * Safety:
 *   - --dry-run reports what WOULD be deleted without touching the database.
 *   - If more than 5 orphans are found, the script aborts (guards against
 *     accidental mass deletion if something unexpected lands in the table).
 *   - The delete runs inside a transaction: any failure rolls back.
 *
 * Usage:
 *   npx tsx scripts/cleanup/delete-orphan-graphs.ts --dry-run
 *   npx tsx scripts/cleanup/delete-orphan-graphs.ts
 */
import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: ['.env.local', '.env'] })
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

const ORPHAN_THRESHOLD = 3
const MAX_EXPECTED_ORPHANS = 5

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const { prisma } = await import('../../src/lib/prisma')

  const orphans = await prisma.sentimentGraph.findMany({
    where: { reviewCount: { lt: ORPHAN_THRESHOLD } },
    select: {
      reviewCount: true,
      overallScore: true,
      generatedAt: true,
      film: {
        select: {
          id: true,
          title: true,
        },
      },
    },
    orderBy: { reviewCount: 'asc' },
  })

  console.log('='.repeat(72))
  console.log(
    `Orphan SentimentGraph rows (reviewCount < ${ORPHAN_THRESHOLD})${dryRun ? ' [DRY RUN]' : ''}`,
  )
  console.log('='.repeat(72))
  console.log(`Total: ${orphans.length}`)
  console.log('')

  if (orphans.length === 0) {
    console.log('(no orphans found, nothing to do)')
    await prisma.$disconnect()
    return
  }

  if (orphans.length > MAX_EXPECTED_ORPHANS) {
    console.error(
      `SAFETY ABORT: found ${orphans.length} orphan graphs, which exceeds the expected ceiling of ${MAX_EXPECTED_ORPHANS}.`,
    )
    console.error(
      'Refusing to proceed. Inspect the list above and, if the deletion is intentional, raise MAX_EXPECTED_ORPHANS in the script.',
    )
    await prisma.$disconnect()
    process.exit(1)
  }

  for (const g of orphans) {
    console.log(`- ${g.film.title}`)
    console.log(`    film.id:       ${g.film.id}`)
    console.log(`    reviewCount:   ${g.reviewCount}`)
    console.log(`    overallScore:  ${g.overallScore}`)
    console.log(`    generatedAt:   ${g.generatedAt.toISOString()}`)
    console.log('')
  }

  if (dryRun) {
    console.log('='.repeat(72))
    console.log('DRY RUN — no changes made')
    console.log('='.repeat(72))
    await prisma.$disconnect()
    return
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const res = await tx.sentimentGraph.deleteMany({
      where: { reviewCount: { lt: ORPHAN_THRESHOLD } },
    })
    return res.count
  })

  console.log('='.repeat(72))
  console.log(`DELETED ${deleted} rows`)
  console.log('='.repeat(72))

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
