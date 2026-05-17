import './_load-env'
import './_neon-ws'
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

interface FilmRef {
  title: string
  year: number
}

interface Pair {
  source: FilmRef
  candidate: FilmRef
}

const PAIRS: Pair[] = [
  { source: { title: 'Inception', year: 2010 }, candidate: { title: 'Interstellar', year: 2014 } },
  { source: { title: 'Inception', year: 2010 }, candidate: { title: 'Memento', year: 2000 } },
  { source: { title: '12 Angry Men', year: 1957 }, candidate: { title: 'The Verdict', year: 1982 } },
  { source: { title: '12 Angry Men', year: 1957 }, candidate: { title: 'Witness for the Prosecution', year: 1957 } },
  { source: { title: 'Heat', year: 1995 }, candidate: { title: 'The Departed', year: 2006 } },
  { source: { title: 'The Princess Bride', year: 1987 }, candidate: { title: 'Stardust', year: 2007 } },
]

async function findFilm(ref: FilmRef) {
  const matches = await prisma.film.findMany({
    where: { title: { equals: ref.title, mode: 'insensitive' } },
    select: { id: true, title: true, releaseDate: true, keywords: true },
  })
  if (matches.length === 0) return null
  const exact = matches.find(
    (m) => m.releaseDate && new Date(m.releaseDate).getFullYear() === ref.year,
  )
  return exact ?? matches[0]
}

function jaccardStats(a: readonly string[], b: readonly string[]) {
  const setA = new Set(a)
  const setB = new Set(b)
  const shared: string[] = []
  for (const x of setA) {
    if (setB.has(x)) shared.push(x)
  }
  const union = setA.size + setB.size - shared.length
  const jaccard = union === 0 ? 0 : shared.length / union
  return { shared: shared.sort(), union, jaccard }
}

function formatArr(items: readonly string[]): string {
  if (items.length === 0) return '  (none)'
  return `  [${items.map((s) => JSON.stringify(s)).join(', ')}]`
}

async function pairPass() {
  for (const pair of PAIRS) {
    const [source, candidate] = await Promise.all([findFilm(pair.source), findFilm(pair.candidate)])

    console.log('═══════════════════════════════════════')
    console.log(
      `PAIR: ${pair.source.title} (${pair.source.year}) ↔ ${pair.candidate.title} (${pair.candidate.year})`,
    )

    if (!source) {
      console.log(`  MISSING source: ${pair.source.title} (${pair.source.year})`)
      continue
    }
    if (!candidate) {
      console.log(`  MISSING candidate: ${pair.candidate.title} (${pair.candidate.year})`)
      continue
    }

    console.log(`${source.title}: ${source.keywords.length} keywords`)
    console.log(formatArr(source.keywords))
    console.log(`${candidate.title}: ${candidate.keywords.length} keywords`)
    console.log(formatArr(candidate.keywords))

    const { shared, union, jaccard } = jaccardStats(source.keywords, candidate.keywords)
    console.log(`Shared (${shared.length}):`)
    console.log(formatArr(shared))
    console.log(`Union: ${union}`)
    console.log(`Jaccard: ${jaccard.toFixed(3)}`)
    console.log()
  }
}

interface RandomKwRow {
  kw: string
}

async function normalizationPass() {
  console.log('═══════════════════════════════════════')
  console.log('NORMALIZATION SANITY CHECK (20 random keywords)')
  console.log('═══════════════════════════════════════')

  const rows = await prisma.$queryRaw<RandomKwRow[]>`
    SELECT unnest("keywords") AS kw
    FROM "Film"
    WHERE array_length("keywords", 1) > 0
    ORDER BY random()
    LIMIT 20
  `

  if (rows.length === 0) {
    console.log('  no keywords found in catalog. Did the backfill run?')
    return
  }

  // Printable Latin-1 + common punctuation. Anything outside (CJK, emoji, smart
  // quotes, etc.) gets flagged for visual inspection — not a hard fail.
  const printableLatin = /^[\x20-\x7E\xA0-\xFF]*$/

  let issues = 0
  for (const row of rows) {
    const kw = row.kw
    const isLower = kw === kw.toLowerCase()
    const isTrimmed = kw === kw.trim()
    const isNonEmpty = kw.length > 0
    const isPrintable = printableLatin.test(kw)
    const flags: string[] = []
    if (!isLower) flags.push('MIXED-CASE')
    if (!isTrimmed) flags.push('WHITESPACE')
    if (!isNonEmpty) flags.push('EMPTY')
    if (!isPrintable) flags.push('NON-LATIN1')
    if (flags.length > 0) issues++
    console.log(
      `  ${JSON.stringify(kw)}  len=${kw.length}  ${flags.length === 0 ? 'OK' : flags.join(',')}`,
    )
  }

  console.log()
  console.log(`Normalization summary: ${rows.length - issues}/${rows.length} clean, ${issues} flagged.`)
}

async function main() {
  console.log('PR 4a — keyword overlap diagnostic\n')
  await pairPass()
  await normalizationPass()
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
