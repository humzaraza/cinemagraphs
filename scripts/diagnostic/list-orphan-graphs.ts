/**
 * Read-only diagnostic: list every SentimentGraph row with reviewCount < 3.
 * Written during 3d.3 sentiment graph threshold alignment (April 2026).
 * These are "orphan graphs" generated under the old (1-or-2 review) thresholds
 * that the new aligned threshold (3) will treat as below the floor. Step
 * 3d.3.b will delete this exact set.
 *
 * Usage: npx tsx scripts/diagnostic/list-orphan-graphs.ts
 */
import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: ['.env.local', '.env'] })
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

const ORPHAN_THRESHOLD = 3

async function main() {
  const { prisma } = await import('../../src/lib/prisma')

  const orphans = await prisma.sentimentGraph.findMany({
    where: { reviewCount: { lt: ORPHAN_THRESHOLD } },
    select: {
      reviewCount: true,
      overallScore: true,
      sourcesUsed: true,
      generatedAt: true,
      film: {
        select: {
          id: true,
          title: true,
          releaseDate: true,
        },
      },
    },
    orderBy: { reviewCount: 'asc' },
  })

  console.log('='.repeat(72))
  console.log(`Orphan SentimentGraph rows (reviewCount < ${ORPHAN_THRESHOLD})`)
  console.log('='.repeat(72))
  console.log(`Total: ${orphans.length}`)
  console.log('')

  if (orphans.length === 0) {
    console.log('(no orphans found)')
    await prisma.$disconnect()
    return
  }

  for (const g of orphans) {
    console.log(`- ${g.film.title}`)
    console.log(`    film.id:           ${g.film.id}`)
    console.log(`    film.releaseDate:  ${g.film.releaseDate?.toISOString() ?? '(null)'}`)
    console.log(`    reviewCount:       ${g.reviewCount}`)
    console.log(`    overallScore:      ${g.overallScore}`)
    console.log(`    sourcesUsed:       [${(g.sourcesUsed ?? []).join(', ')}]`)
    console.log(`    generatedAt:       ${g.generatedAt.toISOString()}`)
    console.log('')
  }

  console.log('='.repeat(72))
  console.log(`Summary: ${orphans.length} orphan graph(s) below threshold of ${ORPHAN_THRESHOLD}`)
  console.log('='.repeat(72))

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
