import './_load-env'
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

interface Sample {
  title: string
  year: number
  hint: string
}

const SAMPLES: Sample[] = [
  { title: '12 Angry Men', year: 1957, hint: 'courtroom / ensemble / single location' },
  { title: 'Inception', year: 2010, hint: 'mind-bending sci-fi heist' },
  { title: 'The Princess Bride', year: 1987, hint: 'fantasy adventure / romance / comedy' },
  { title: 'Spirited Away', year: 2001, hint: 'animated foreign fantasy / Ghibli' },
  { title: 'Heat', year: 1995, hint: 'crime thriller / cat-and-mouse / ensemble' },
]

const N = 8

async function findSample(s: Sample) {
  const candidates = await prisma.film.findMany({
    where: { title: { equals: s.title, mode: 'insensitive' } },
    select: { id: true, title: true, releaseDate: true, director: true, keywords: true, genres: true },
  })
  if (candidates.length === 0) return null
  const exact = candidates.find(
    (c) => c.releaseDate && new Date(c.releaseDate).getFullYear() === s.year,
  )
  return exact ?? candidates[0]
}

async function main() {
  console.log('PR 4a — similar films sanity dump\n')

  for (const sample of SAMPLES) {
    const source = await findSample(sample)
    console.log('───────────────────────────────────────────')
    console.log(`SOURCE: ${sample.title} (${sample.year})`)
    console.log(`  hint: ${sample.hint}`)
    if (!source) {
      console.log('  MISSING from DB. Skipping.\n')
      continue
    }
    console.log(`  matched: ${source.title} (${source.releaseDate ? new Date(source.releaseDate).getFullYear() : '?'})  dir=${source.director ?? '?'}`)
    console.log(`  source keywords (${source.keywords.length}): ${source.keywords.slice(0, 12).join(', ')}${source.keywords.length > 12 ? '...' : ''}`)
    console.log(`  source genres: ${source.genres.join(', ')}`)

    const rows = await prisma.similarFilm.findMany({
      where: { filmId: source.id },
      orderBy: { similarityScore: 'desc' },
      take: N,
      include: {
        similar: {
          select: { title: true, releaseDate: true, director: true },
        },
      },
    })

    if (rows.length === 0) {
      console.log('  no SimilarFilm rows. Did the backfill run?\n')
      continue
    }

    console.log(`  TOP ${N}:`)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const y = r.similar.releaseDate ? new Date(r.similar.releaseDate).getFullYear() : '?'
      const score = r.similarityScore.toFixed(3)
      const sig = r.matchSignals as Record<string, number | boolean>
      const sigStr = `kw=${(sig.keywords as number ?? 0).toFixed(2)} gen=${(sig.genres as number ?? 0).toFixed(2)} dir=${sig.director ?? 0} era=${(sig.era as number ?? 0).toFixed(2)}${sig.keywordsDegraded ? ' [DEGRADED]' : ''}`
      console.log(`    ${(i + 1).toString().padStart(2)}.  [${score}]  ${r.similar.title} (${y})  dir=${r.similar.director ?? '?'}`)
      console.log(`           ${sigStr}`)
    }
    console.log()
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
