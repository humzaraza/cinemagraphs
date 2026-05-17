import './_load-env'
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

if (!TMDB_API_KEY) {
  console.error('TMDB_API_KEY not found in environment')
  process.exit(1)
}

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

interface TMDBKeyword {
  id: number
  name: string
}

interface TMDBKeywordsResponse {
  id: number
  keywords: TMDBKeyword[]
}

async function fetchKeywords(tmdbId: number): Promise<string[]> {
  const res = await fetch(`${TMDB_BASE_URL}/movie/${tmdbId}/keywords`, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
  })
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${res.statusText}`)
  const data = (await res.json()) as TMDBKeywordsResponse
  return data.keywords.map((k) => k.name.toLowerCase())
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const BATCH_SIZE = 35
const RATE_LIMIT_DELAY_MS = 10_000

async function main() {
  const force = process.argv.includes('--force')
  console.log(`Backfill mode: ${force ? 'FORCE (re-fetch all)' : 'idempotent (skip non-empty)'}`)

  const films = await prisma.film.findMany({
    select: { id: true, title: true, tmdbId: true, keywords: true },
    orderBy: { title: 'asc' },
  })

  const todo = force ? films : films.filter((f) => f.keywords.length === 0)
  console.log(`Total films: ${films.length}  |  Needs backfill: ${todo.length}\n`)
  if (todo.length === 0) {
    await prisma.$disconnect()
    return
  }

  let updated = 0
  let emptyResults = 0
  const failures: string[] = []

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE)
    const results = await Promise.allSettled(
      batch.map(async (film, idx) => {
        const n = i + idx + 1
        const keywords = await fetchKeywords(film.tmdbId)
        await prisma.film.update({ where: { id: film.id }, data: { keywords } })
        console.log(`[${n}/${todo.length}] ${film.title}  →  ${keywords.length} keywords`)
        return keywords.length
      }),
    )

    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      if (r.status === 'fulfilled') {
        updated++
        if (r.value === 0) emptyResults++
      } else {
        failures.push(`${batch[j].title} (tmdbId=${batch[j].tmdbId}): ${r.reason}`)
        console.error(`  ✗ Failed: ${batch[j].title} — ${r.reason}`)
      }
    }

    if (i + BATCH_SIZE < todo.length) {
      console.log(`  → Batch done. Waiting ${RATE_LIMIT_DELAY_MS / 1000}s for rate limit...\n`)
      await sleep(RATE_LIMIT_DELAY_MS)
    }
  }

  console.log('\n═══════════════════════════════════════════')
  console.log('         KEYWORDS BACKFILL COMPLETE')
  console.log('═══════════════════════════════════════════')
  console.log(`Films updated:       ${updated}`)
  console.log(`Empty keyword sets:  ${emptyResults}`)
  console.log(`Failures:            ${failures.length}`)
  if (failures.length > 0) {
    console.log('\nFailed films:')
    failures.forEach((f) => console.log(`  - ${f}`))
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
