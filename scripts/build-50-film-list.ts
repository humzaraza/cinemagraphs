/**
 * One-off: build the 50-film list for the pre-flight Step C bulk run.
 * Seven buckets (a redefined per user):
 *   a. 10 films whose SentimentGraph was generated before 2026-04-19 UTC
 *   b. 5 films with non-ASCII / accented titles
 *   c. 5 films with no SentimentGraph row
 *   d. 5 films with Wikipedia plot < 1500 chars (probed)
 *   e. 5 films with runtime = null
 *   f. 5 films with imdbRating or rtCriticsScore null
 *   g. 15 random from remaining eligible pool
 *
 * All candidates must be eligible: not pre-release, ≥3 quality reviews,
 * and for hybrid-mode candidates have a release year.
 *
 * Bucket (d) probes Wikipedia up to 30 candidates to find 5 short-plot films.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

const DUAL_LABEL_CUTOFF = new Date('2026-04-19T00:00:00Z')

interface Bucket {
  tag: string
  filmId: string
  title: string
  meta: Record<string, unknown>
}

async function main() {
  const [{ isQualityReview }, { fetchWikipediaPlot }] = await Promise.all([
    import('../src/lib/sentiment-pipeline'),
    import('../src/lib/sources/wikipedia'),
  ])

  const films = await prisma.film.findMany({
    include: {
      reviews: { select: { reviewText: true } },
      sentimentGraph: {
        select: { id: true, generatedAt: true, version: true },
      },
    },
    orderBy: { id: 'asc' },
  })
  const now = new Date()

  type Summary = {
    id: string
    title: string
    releaseDate: Date | null
    runtime: number | null
    imdbRating: number | null
    rtCriticsScore: number | null
    rtAudienceScore: number | null
    metacriticScore: number | null
    qualityCount: number
    hasGraph: boolean
    graphGeneratedAt: Date | null
    graphVersion: number | null
    prerelease: boolean
    eligible: boolean
    nonAscii: boolean
  }

  const all: Summary[] = films.map((f) => {
    const qualityCount = f.reviews.filter((r) => isQualityReview(r.reviewText)).length
    const prerelease = f.releaseDate !== null && f.releaseDate > now
    const eligible = !prerelease && qualityCount >= 3
    return {
      id: f.id,
      title: f.title,
      releaseDate: f.releaseDate,
      runtime: f.runtime,
      imdbRating: f.imdbRating,
      rtCriticsScore: f.rtCriticsScore,
      rtAudienceScore: f.rtAudienceScore,
      metacriticScore: f.metacriticScore,
      qualityCount,
      hasGraph: f.sentimentGraph !== null,
      graphGeneratedAt: f.sentimentGraph?.generatedAt ?? null,
      graphVersion: f.sentimentGraph?.version ?? null,
      prerelease,
      eligible,
      nonAscii: /[^\x00-\x7F]/.test(f.title),
    }
  })

  const eligibleCount = all.filter((s) => s.eligible).length
  console.log(
    `Loaded ${films.length} films | eligible (not prerelease, ≥3 quality): ${eligibleCount} | with graph: ${all.filter((s) => s.hasGraph).length}`
  )
  console.log('')

  const used = new Set<string>()
  const picked: Bucket[] = []

  function add(tag: string, s: Summary, meta: Record<string, unknown>) {
    picked.push({ tag, filmId: s.id, title: s.title, meta })
    used.add(s.id)
  }

  // Deterministic random via seeded shuffle — so re-running picks the same sample
  // unless the DB changes. Simple LCG seeded from a fixed constant.
  let rngState = 0x9e3779b9
  function rand(): number {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff
    return rngState / 0x7fffffff
  }
  function shuffle<T>(arr: T[]): T[] {
    const copy = [...arr]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }

  // ── Bucket (a): 10 films with stale SentimentGraph (pre-2026-04-19) ─────────
  const preDualLabel = all.filter(
    (s) =>
      s.eligible &&
      s.hasGraph &&
      s.graphGeneratedAt !== null &&
      s.graphGeneratedAt < DUAL_LABEL_CUTOFF
  )
  const aPool = shuffle(preDualLabel).slice(0, 10)
  for (const s of aPool) {
    add('a', s, {
      graphGeneratedAt: s.graphGeneratedAt!.toISOString(),
      graphVersion: s.graphVersion,
      qualityCount: s.qualityCount,
    })
  }
  console.log(`[a] stale-graph eligible pool: ${preDualLabel.length} | picked: ${aPool.length}`)

  // ── Bucket (b): 5 non-ASCII / accented titles ───────────────────────────────
  const nonAsciiPool = all.filter((s) => s.eligible && s.nonAscii && !used.has(s.id))
  const bPool = shuffle(nonAsciiPool).slice(0, 5)
  for (const s of bPool) {
    add('b', s, { qualityCount: s.qualityCount })
  }
  console.log(`[b] non-ASCII eligible pool: ${nonAsciiPool.length} | picked: ${bPool.length}`)

  // ── Bucket (c): 5 no SentimentGraph ─────────────────────────────────────────
  const noGraphPool = all.filter((s) => s.eligible && !s.hasGraph && !used.has(s.id))
  const cPool = shuffle(noGraphPool).slice(0, 5)
  for (const s of cPool) {
    add('c', s, { qualityCount: s.qualityCount, hasGraph: false })
  }
  console.log(`[c] no-graph eligible pool: ${noGraphPool.length} | picked: ${cPool.length}`)

  // ── Bucket (e): 5 null runtime ──────────────────────────────────────────────
  const nullRuntimePool = all.filter(
    (s) => s.eligible && s.runtime === null && !used.has(s.id)
  )
  const ePool = shuffle(nullRuntimePool).slice(0, 5)
  for (const s of ePool) {
    add('e', s, { runtime: null, qualityCount: s.qualityCount })
  }
  console.log(`[e] null-runtime eligible pool: ${nullRuntimePool.length} | picked: ${ePool.length}`)

  // ── Bucket (f): 5 null anchor score ─────────────────────────────────────────
  const partialAnchorPool = all.filter(
    (s) =>
      s.eligible &&
      !used.has(s.id) &&
      (s.imdbRating === null || s.rtCriticsScore === null)
  )
  const fPool = shuffle(partialAnchorPool).slice(0, 5)
  for (const s of fPool) {
    const nullFields: string[] = []
    if (s.imdbRating === null) nullFields.push('imdbRating')
    if (s.rtCriticsScore === null) nullFields.push('rtCriticsScore')
    if (s.metacriticScore === null) nullFields.push('metacriticScore')
    if (s.rtAudienceScore === null) nullFields.push('rtAudienceScore')
    add('f', s, {
      nullFields,
      imdbRating: s.imdbRating,
      rtCriticsScore: s.rtCriticsScore,
      metacriticScore: s.metacriticScore,
    })
  }
  console.log(`[f] partial-anchor eligible pool: ${partialAnchorPool.length} | picked: ${fPool.length}`)

  // ── Bucket (d): 5 short Wikipedia plots (<1500 chars) ───────────────────────
  // Probe up to 30 candidates from eligible films with a release year, not yet used.
  const probeEligible = all.filter(
    (s) => s.eligible && s.releaseDate !== null && !used.has(s.id)
  )
  const probePool = shuffle(probeEligible).slice(0, 30)
  console.log(`[d] probing up to ${probePool.length} films for short plots...`)
  const shortPlotFilms: { s: Summary; plotLen: number }[] = []
  for (const s of probePool) {
    if (shortPlotFilms.length >= 5) break
    const year = s.releaseDate!.getFullYear()
    const plot = await fetchWikipediaPlot(s.title, year)
    const len = plot?.length ?? 0
    if (plot && len > 0 && len < 1500) {
      shortPlotFilms.push({ s, plotLen: len })
    }
  }
  for (const { s, plotLen } of shortPlotFilms) {
    add('d', s, { plotLength: plotLen, qualityCount: s.qualityCount })
  }
  console.log(`[d] short-plot (<1500) found: ${shortPlotFilms.length}`)

  // ── Bucket (g): 15 random from remaining eligible pool ──────────────────────
  const remainder = all.filter((s) => s.eligible && !used.has(s.id))
  const target = 50 - picked.length
  const gPool = shuffle(remainder).slice(0, target)
  for (const s of gPool) {
    add('g', s, {
      qualityCount: s.qualityCount,
      hasGraph: s.hasGraph,
      runtime: s.runtime,
    })
  }
  console.log(`[g] remainder eligible pool: ${remainder.length} | picked: ${gPool.length}  (target=${target})`)
  console.log('')

  // ── Shortfall summary ───────────────────────────────────────────────────────
  const tallies: Record<string, number> = {}
  for (const p of picked) tallies[p.tag] = (tallies[p.tag] ?? 0) + 1
  const targets: Record<string, number> = { a: 10, b: 5, c: 5, d: 5, e: 5, f: 5, g: 15 }
  console.log('=== BUCKET TALLIES ===')
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    const got = tallies[k] ?? 0
    const want = targets[k]
    const flag = got < want ? `SHORT by ${want - got}` : 'OK'
    console.log(`  [${k}] picked=${got}/${want}  ${flag}`)
  }
  console.log(`  TOTAL picked=${picked.length}/50`)
  console.log('')

  // ── Full list ───────────────────────────────────────────────────────────────
  console.log('=== FULL 50-FILM LIST ===')
  for (const p of picked) {
    console.log(`[${p.tag}] ${p.filmId}  "${p.title}"  ${JSON.stringify(p.meta)}`)
  }
  console.log('')

  // Machine-readable IDs for the next step
  console.log('=== COMMA-SEPARATED FILM IDS ===')
  console.log(picked.map((p) => p.filmId).join(','))

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
