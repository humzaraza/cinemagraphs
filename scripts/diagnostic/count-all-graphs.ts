/**
 * Read-only diagnostic: total SentimentGraph row count. Useful for before/after
 * comparisons around bulk operations.
 * Written during 3d.3 sentiment graph threshold alignment (April 2026).
 *
 * Usage: npx tsx scripts/diagnostic/count-all-graphs.ts
 */
import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: ['.env.local', '.env'] })
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

async function main() {
  const { prisma } = await import('../../src/lib/prisma')
  const total = await prisma.sentimentGraph.count()
  console.log(`TOTAL SentimentGraph rows: ${total}`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
