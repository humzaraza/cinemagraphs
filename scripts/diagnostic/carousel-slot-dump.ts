/**
 * Read-only diagnostic: verify carousel slot-selection picks for a handful of
 * films. Mirrors what /api/admin/carousel/prepare + selectBeatSlots would
 * produce in the browser, but runs directly against the DB without auth so
 * agents can generate verification tables.
 *
 * Usage: npx tsx scripts/diagnostic/carousel-slot-dump.ts
 */
import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: ['.env.local', '.env'] })
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import type { Beat } from '../../src/lib/carousel/slot-selection'
import type { SentimentDataPoint } from '../../src/lib/types'

// Prisma is dynamically imported inside main() so that dotenv runs before
// the Neon connection string is read at module-load time.
type PrismaClient = Awaited<ReturnType<typeof loadPrisma>>
async function loadPrisma() {
  const mod = await import('../../src/lib/prisma')
  return mod.prisma
}

async function findFilmByTitle(prisma: PrismaClient, title: string, year?: number) {
  const candidates = await prisma.film.findMany({
    where: { title: { equals: title }, status: 'ACTIVE' },
    select: {
      id: true,
      title: true,
      releaseDate: true,
      runtime: true,
      sentimentGraph: { select: { overallScore: true, dataPoints: true } },
    },
  })

  if (candidates.length === 0) return null
  const withGraph = candidates.filter((c) => c.sentimentGraph !== null)
  const pool = withGraph.length > 0 ? withGraph : candidates
  if (year) {
    const exact = pool.find(
      (c) => c.releaseDate && new Date(c.releaseDate).getFullYear() === year
    )
    if (exact) return exact
  }
  return pool[0]
}

async function findFlatArcFilm(prisma: PrismaClient) {
  const films = await prisma.film.findMany({
    where: {
      status: 'ACTIVE',
      sentimentGraph: { isNot: null },
      runtime: { gte: 75 },
    },
    select: {
      id: true,
      title: true,
      releaseDate: true,
      runtime: true,
      sentimentGraph: { select: { overallScore: true, dataPoints: true } },
    },
    take: 2000,
  })

  type Candidate = (typeof films)[number] & { variance: number; beatCount: number }
  const candidates: Candidate[] = []
  for (const f of films) {
    const raw = f.sentimentGraph?.dataPoints
    const dp = (Array.isArray(raw) ? raw : []) as unknown as SentimentDataPoint[]
    if (dp.length < 8) continue
    const scores = dp.map((b) => b.score)
    const variance = Math.max(...scores) - Math.min(...scores)
    if (variance < 1.5) {
      candidates.push({ ...f, variance, beatCount: dp.length })
    }
  }

  candidates.sort((a, b) => a.variance - b.variance || b.beatCount - a.beatCount)
  return candidates[0] ?? null
}

function fmtScore(n: number): string {
  return n.toFixed(2)
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s
  return s + ' '.repeat(n - s.length)
}

async function printTable(label: string, film: {
  id: string
  title: string
  releaseDate: Date | null
  runtime: number | null
  sentimentGraph: { overallScore: number; dataPoints: unknown } | null
}) {
  const { selectBeatSlots } = await import('../../src/lib/carousel/slot-selection')
  console.log('')
  console.log(`=== ${label}: ${film.title} ===`)
  if (!film.sentimentGraph) {
    console.log('  SKIPPED — film has no sentimentGraph')
    return
  }
  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : '—'
  const runtime = film.runtime ?? 0
  const raw = film.sentimentGraph.dataPoints
  const dp = (Array.isArray(raw) ? raw : []) as unknown as SentimentDataPoint[]
  const beats: Beat[] = [...dp].sort((a, b) => a.timeMidpoint - b.timeMidpoint)
  const slots = selectBeatSlots(beats, runtime)

  console.log(
    `  year=${year} runtime=${runtime}m beats=${beats.length} overallScore=${fmtScore(film.sentimentGraph.overallScore)}`
  )
  console.log('')

  const rows: string[][] = [['#', 'Kind', 'Time', 'Score', 'Label', 'Collision']]
  for (const s of slots) {
    const label = s.beat ? (s.beat.labelFull ?? s.beat.label) : 'placeholder'
    rows.push([
      String(s.position),
      s.kind,
      s.beat ? s.timestampLabel : '—',
      s.beat ? fmtScore(s.beat.score) : '—',
      label,
      s.collision ? 'yes' : 'no',
    ])
  }

  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)))
  const line = (r: string[]) => r.map((v, i) => pad(v, widths[i])).join('  ')
  const sep = widths.map((w) => '-'.repeat(w)).join('  ')
  console.log('  ' + line(rows[0]))
  console.log('  ' + sep)
  for (let i = 1; i < rows.length; i++) {
    console.log('  ' + line(rows[i]))
  }
}

async function main() {
  const prisma = await loadPrisma()

  const phm = await findFilmByTitle(prisma, 'Project Hail Mary')
  const oppen = await findFilmByTitle(prisma, 'Oppenheimer')
  const matilda = await findFilmByTitle(prisma, 'Matilda', 1996)
  const flat = await findFlatArcFilm(prisma)

  if (!phm) console.log('Project Hail Mary: NOT FOUND')
  else await printTable('1) V-shape test — Project Hail Mary', phm)

  if (!oppen) console.log('Oppenheimer: NOT FOUND')
  else await printTable('2) Sustained build test — Oppenheimer', oppen)

  if (!matilda) console.log('Matilda (1996): NOT FOUND')
  else await printTable('3) Episodic test — Matilda (1996)', matilda)

  if (!flat) {
    console.log('No flat-arc candidate found')
  } else {
    const raw = flat.sentimentGraph?.dataPoints
    const dp = (Array.isArray(raw) ? raw : []) as unknown as SentimentDataPoint[]
    const scores = dp.map((b) => b.score)
    const variance = Math.max(...scores) - Math.min(...scores)
    console.log('')
    console.log(
      `>>> Flat-arc pick: "${flat.title}" — variance ${variance.toFixed(2)} across ${dp.length} beats (lowest variance in catalog with >=6 beats)`
    )
    await printTable('4) Flat-arc test', flat)
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
