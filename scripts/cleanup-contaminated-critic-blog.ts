/**
 * One-off audit: find CRITIC_BLOG review rows whose body doesn't mention
 * the associated film's director surname — a signal the row was fetched
 * for a different film that happened to share a slug on rogerebert.com.
 *
 * Dry-run by default: prints the counts and the first 10 flagged rows
 * for sanity review, deletes nothing. Pass --commit to actually delete.
 *
 * Usage:
 *   npx tsx scripts/cleanup-contaminated-critic-blog.ts           # dry run
 *   npx tsx scripts/cleanup-contaminated-critic-blog.ts --commit  # delete
 */
import 'dotenv/config'
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import { prisma } from '../src/lib/prisma'

function extractDirectorSurnames(director: string): string[] {
  return director
    .split(/,|\s+and\s+/i)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const words = name.split(/\s+/).filter(Boolean)
      return words[words.length - 1] || ''
    })
    .filter(Boolean)
}

async function main() {
  const commit = process.argv.includes('--commit')
  const mode = commit ? 'COMMIT' : 'DRY RUN'
  console.log(`cleanup-contaminated-critic-blog: ${mode}\n`)

  const rows = await prisma.review.findMany({
    where: { sourcePlatform: 'CRITIC_BLOG' },
    select: {
      id: true,
      reviewText: true,
      sourceUrl: true,
      film: { select: { id: true, title: true, director: true } },
    },
  })

  console.log(`Checked ${rows.length} CRITIC_BLOG reviews.`)

  const flagged: Array<{
    id: string
    filmTitle: string
    director: string | null
    sourceUrl: string | null
    bodyPreview: string
  }> = []
  let skippedNoDirector = 0

  for (const row of rows) {
    const director = row.film?.director?.trim()
    if (!director) {
      skippedNoDirector++
      continue
    }
    const surnames = extractDirectorSurnames(director)
    if (surnames.length === 0) {
      skippedNoDirector++
      continue
    }
    const bodyLower = row.reviewText.toLowerCase()
    const hasSurname = surnames.some((s) => bodyLower.includes(s.toLowerCase()))
    if (!hasSurname) {
      flagged.push({
        id: row.id,
        filmTitle: row.film?.title ?? '(unknown)',
        director,
        sourceUrl: row.sourceUrl,
        bodyPreview: row.reviewText.slice(0, 100).replace(/\s+/g, ' '),
      })
    }
  }

  console.log(`Skipped ${skippedNoDirector} rows (film has no director).`)
  console.log(`Flagged ${flagged.length} rows for deletion.\n`)

  if (flagged.length > 0) {
    console.log('First 10 flagged rows:')
    for (const row of flagged.slice(0, 10)) {
      console.log(`  - [${row.filmTitle}] director="${row.director}"`)
      console.log(`    url: ${row.sourceUrl ?? '(none)'}`)
      console.log(`    body: ${row.bodyPreview}...`)
    }
    console.log()
  }

  if (!commit) {
    console.log('Dry run — no rows deleted. Pass --commit to execute.')
    await prisma.$disconnect()
    return
  }

  if (flagged.length === 0) {
    console.log('Nothing to delete.')
    await prisma.$disconnect()
    return
  }

  const result = await prisma.review.deleteMany({
    where: { id: { in: flagged.map((r) => r.id) } },
  })
  console.log(`Deleted ${result.count} rows.`)
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
