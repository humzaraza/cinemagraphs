/**
 * Wipe test UserReview rows, preserving only the legitimate surawjeez review.
 *
 * Context: 10 of 11 UserReview rows are early-development test data that
 * would otherwise be blended into hybrid beats by maybeBlendAndUpdate,
 * polluting the clean hybrid baseline being prepared in prompt 3c.3.
 * The surawjeez row (userId=cmnytwc47000004jyagnuqwb2, film="Another Round")
 * is a real user review and must be preserved.
 *
 * Neon point-in-time restore covers accidental data loss; no archival here.
 *
 * Dry-run by default: lists rows targeted for deletion. Pass --commit to
 * actually delete.
 *
 * Usage:
 *   npx tsx scripts/wipe-test-user-reviews.ts           # dry run
 *   npx tsx scripts/wipe-test-user-reviews.ts --commit  # delete
 */
import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: ['.env.local', '.env'] })

import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

const KEEP_USER_ID = 'cmnytwc47000004jyagnuqwb2'

async function main() {
  const commit = process.argv.includes('--commit')
  const mode = commit ? 'COMMIT' : 'DRY RUN'
  console.log(`wipe-test-user-reviews: ${mode}`)
  console.log(`Preserving userId=${KEEP_USER_ID}\n`)

  const { prisma } = await import('../src/lib/prisma')

  const allRows = await prisma.userReview.findMany({
    select: {
      id: true,
      userId: true,
      filmId: true,
      overallRating: true,
      createdAt: true,
      film: { select: { title: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const toDelete = allRows.filter((r) => r.userId !== KEEP_USER_ID)
  const toKeep = allRows.filter((r) => r.userId === KEEP_USER_ID)

  console.log(`Total UserReview rows: ${allRows.length}`)
  console.log(`Rows to keep (userId=${KEEP_USER_ID}): ${toKeep.length}`)
  console.log(`Rows flagged for deletion: ${toDelete.length}\n`)

  console.log('Flagged for deletion:')
  for (const r of toDelete) {
    console.log(
      `  - id=${r.id} userId=${r.userId} film="${r.film?.title ?? '(unknown)'}" rating=${r.overallRating} createdAt=${r.createdAt.toISOString()}`
    )
  }
  console.log()

  console.log('Preserving:')
  for (const r of toKeep) {
    console.log(
      `  - id=${r.id} userId=${r.userId} film="${r.film?.title ?? '(unknown)'}" rating=${r.overallRating} createdAt=${r.createdAt.toISOString()}`
    )
  }
  console.log()

  if (!commit) {
    console.log('Dry run — no rows deleted. Pass --commit to execute.')
    await prisma.$disconnect()
    return
  }

  const result = await prisma.userReview.deleteMany({
    where: { userId: { not: KEEP_USER_ID } },
  })
  console.log(`Deleted ${result.count} rows.`)

  const finalCount = await prisma.userReview.count()
  console.log(`Final UserReview count: ${finalCount}`)

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  process.exit(1)
})
