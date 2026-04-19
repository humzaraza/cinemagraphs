/**
 * One-off: post-run analysis of the 50-film bulk-regen-hybrid batch.
 * Reads /tmp/50-bucket-map.json for bucket membership, queries each film's
 * SentimentGraph, and produces all verifications listed in the step spec.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import fs from 'node:fs'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

interface BucketMap {
  generatedAt: string
  dualLabelCutoff: string
  shortRuntimeIds: string[]
  titles: Record<string, string>
  buckets: Record<string, string[]>
}

interface Beat {
  label?: unknown
  labelFull?: unknown
  timeStart?: unknown
  timeEnd?: unknown
  score?: unknown
}

function isDualLabeled(b: Beat): boolean {
  return (
    typeof b.label === 'string' &&
    (b.label as string).trim() !== '' &&
    typeof b.labelFull === 'string' &&
    (b.labelFull as string).trim() !== ''
  )
}

function momentOk(m: unknown): boolean {
  if (m === null || typeof m !== 'object') return false
  const o = m as Record<string, unknown>
  return (
    typeof o.label === 'string' &&
    (o.label as string).trim() !== '' &&
    typeof o.labelFull === 'string' &&
    (o.labelFull as string).trim() !== ''
  )
}

async function main() {
  const map: BucketMap = JSON.parse(fs.readFileSync('/tmp/50-bucket-map.json', 'utf8'))
  const cutoff = new Date(map.dualLabelCutoff)
  const allIds = Object.values(map.buckets).flat()
  console.log(`Loaded bucket map: ${allIds.length} film IDs across ${Object.keys(map.buckets).length} buckets`)
  console.log(`Dual-label cutoff: ${map.dualLabelCutoff}`)
  console.log('')

  // Bucket lookup: filmId → bucket tag
  const bucketOf: Record<string, string> = {}
  for (const [tag, ids] of Object.entries(map.buckets)) {
    for (const id of ids) bucketOf[id] = tag
  }

  const films = await prisma.film.findMany({
    where: { id: { in: allIds } },
    include: { sentimentGraph: true },
  })
  console.log(`Queried ${films.length} films with graphs`)

  // Per-film record
  interface FilmRecord {
    id: string
    title: string
    bucket: string
    hasGraph: boolean
    generatedAt: Date | null
    version: number | null
    overallScore: number | null
    anchor: number
    anchorDelta: number | null
    beatCount: number
    beatsWithBoth: number
    allBeatsDual: boolean
    peakOk: boolean
    lowOk: boolean
    runtime: number | null
  }

  const records: FilmRecord[] = []
  for (const f of films) {
    const sg = f.sentimentGraph
    const anchor = f.imdbRating ?? 7.0
    const beats = (Array.isArray(sg?.dataPoints) ? (sg!.dataPoints as unknown as Beat[]) : []) as Beat[]
    const beatsWithBoth = beats.filter(isDualLabeled).length
    records.push({
      id: f.id,
      title: f.title,
      bucket: bucketOf[f.id] ?? '?',
      hasGraph: sg !== null,
      generatedAt: sg?.generatedAt ?? null,
      version: sg?.version ?? null,
      overallScore: sg?.overallScore ?? null,
      anchor,
      anchorDelta: sg ? Math.abs(sg.overallScore - anchor) : null,
      beatCount: beats.length,
      beatsWithBoth,
      allBeatsDual: beats.length > 0 && beatsWithBoth === beats.length,
      peakOk: momentOk(sg?.peakMoment),
      lowOk: momentOk(sg?.lowestMoment),
      runtime: f.runtime,
    })
  }

  // ─── (1) Per-bucket tallies ────────────────────────────────────────────────
  console.log('\n=== (1) PER-BUCKET TALLIES ===')
  const byBucket: Record<string, FilmRecord[]> = {}
  for (const r of records) {
    ;(byBucket[r.bucket] ??= []).push(r)
  }
  for (const tag of Object.keys(map.buckets).sort()) {
    const rs = byBucket[tag] ?? []
    const allDual = rs.filter((r) => r.allBeatsDual && r.peakOk && r.lowOk).length
    const withGraph = rs.filter((r) => r.hasGraph).length
    console.log(`  [${tag}] n=${rs.length}  withGraph=${withGraph}  allDualLabeled=${allDual}`)
  }

  // ─── (2) Dual-label verification across all 50 ─────────────────────────────
  console.log('\n=== (2) DUAL-LABEL VERIFICATION (all 50) ===')
  const anyBad = records.filter((r) => !r.hasGraph || !r.allBeatsDual || !r.peakOk || !r.lowOk)
  if (anyBad.length === 0) {
    console.log(`  ✓ All 50 films: every beat has label+labelFull; peak & lowest moments have both fields`)
  } else {
    console.log(`  ✗ ${anyBad.length} films with issues:`)
    for (const r of anyBad) {
      console.log(`    [${r.bucket}] ${r.id} "${r.title}": hasGraph=${r.hasGraph} dualBeats=${r.beatsWithBoth}/${r.beatCount} peak=${r.peakOk} low=${r.lowOk}`)
    }
  }

  // ─── (3) Bucket (a): generatedAt advancement ───────────────────────────────
  console.log('\n=== (3) BUCKET (a): generatedAt ADVANCEMENT ===')
  const bucketA = byBucket['a'] ?? []
  for (const r of bucketA) {
    const beforeCutoff = r.generatedAt !== null && r.generatedAt < cutoff
    const afterRun = r.generatedAt !== null && r.generatedAt > new Date('2026-04-19T16:30:00Z')
    console.log(`  ${r.id} "${r.title}": generatedAt=${r.generatedAt?.toISOString()} beforeCutoff=${beforeCutoff ? 'NO (bug?)' : 'n/a now'} afterRun=${afterRun ? 'YES' : 'NO'}`)
  }

  // ─── (4) Bucket (c): new row existence ─────────────────────────────────────
  console.log('\n=== (4) BUCKET (c): NEW SentimentGraph ROWS ===')
  const bucketC = byBucket['c'] ?? []
  for (const r of bucketC) {
    console.log(`  ${r.id} "${r.title}": hasGraph=${r.hasGraph} beats=${r.beatCount} score=${r.overallScore?.toFixed(2)}`)
  }

  // ─── (5) Short-runtime beat counts ─────────────────────────────────────────
  console.log('\n=== (5) SHORT-RUNTIME BEAT COUNTS ===')
  for (const id of map.shortRuntimeIds) {
    const r = records.find((x) => x.id === id)
    if (!r) continue
    console.log(`  ${id} "${r.title}" runtime=${r.runtime}min → beats=${r.beatCount} score=${r.overallScore?.toFixed(2)}`)
  }

  // ─── (6) Anchor-ceiling histogram ──────────────────────────────────────────
  console.log('\n=== (6) ANCHOR-CEILING HISTOGRAM (|overall - anchor|) ===')
  const buckets: { lo: number; hi: number; label: string }[] = [
    { lo: 0.0, hi: 0.05, label: '[0.00, 0.05)' },
    { lo: 0.05, hi: 0.10, label: '[0.05, 0.10)' },
    { lo: 0.10, hi: 0.15, label: '[0.10, 0.15)' },
    { lo: 0.15, hi: 0.195, label: '[0.15, 0.195)' },
    { lo: 0.195, hi: 0.205, label: '[0.195, 0.205]  ← ceiling cluster' },
    { lo: 0.205, hi: 0.30, label: '(0.205, 0.30)' },
    { lo: 0.30, hi: 999, label: '[0.30, ∞)  ← over-spec' },
  ]
  const counts = new Array(buckets.length).fill(0) as number[]
  const perFilm: { delta: number; r: FilmRecord }[] = []
  for (const r of records) {
    if (r.anchorDelta === null) continue
    perFilm.push({ delta: r.anchorDelta, r })
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]
      if (r.anchorDelta >= b.lo && r.anchorDelta < b.hi) {
        counts[i]++
        break
      }
    }
  }
  const total = perFilm.length
  for (let i = 0; i < buckets.length; i++) {
    const pct = total ? ((counts[i] / total) * 100).toFixed(0) : '0'
    const bar = '█'.repeat(counts[i])
    console.log(`  ${buckets[i].label.padEnd(40)} ${String(counts[i]).padStart(3)} (${pct}%) ${bar}`)
  }
  const ceilingCount = counts[4]
  const ceilingPct = total ? ((ceilingCount / total) * 100).toFixed(0) : '0'
  const overSpecCount = counts[6]
  console.log(`  → ceiling cluster: ${ceilingCount}/${total} (${ceilingPct}%)  [threshold <40%]`)
  console.log(`  → over-spec (Δ ≥ 0.30): ${overSpecCount}`)

  // Top 10 deltas
  console.log('\n  Top 10 largest |overall - anchor| deltas:')
  const topDeltas = [...perFilm].sort((a, b) => b.delta - a.delta).slice(0, 10)
  for (const { delta, r } of topDeltas) {
    console.log(`    Δ=${delta.toFixed(3)}  overall=${r.overallScore?.toFixed(2)}  anchor=${r.anchor.toFixed(2)}  [${r.bucket}] "${r.title}"`)
  }

  // ─── (7) Full JSON dumps — 2 bucket (a) films ──────────────────────────────
  console.log('\n=== (7) BUCKET (a) FULL JSON DUMPS (2 samples) ===')
  const dumpTargets = bucketA.slice(0, 2).map((r) => r.id)
  for (const id of dumpTargets) {
    const f = films.find((x) => x.id === id)!
    const sg = f.sentimentGraph!
    const beats = sg.dataPoints as unknown as Beat[]
    console.log(`\n--- ${id} "${f.title}" ---`)
    console.log(`beatCount: ${beats.length}`)
    console.log(`first 3 beats (label / labelFull only):`)
    for (let i = 0; i < Math.min(3, beats.length); i++) {
      console.log(`  beat[${i}]: label="${String(beats[i].label ?? '')}" | labelFull="${String(beats[i].labelFull ?? '')}"`)
    }
    const peak = sg.peakMoment as { label?: string; labelFull?: string } | null
    const low = sg.lowestMoment as { label?: string; labelFull?: string } | null
    console.log(`peakMoment:   label="${peak?.label ?? ''}" | labelFull="${peak?.labelFull ?? ''}"`)
    console.log(`lowestMoment: label="${low?.label ?? ''}" | labelFull="${low?.labelFull ?? ''}"`)
    console.log(`overallScore: ${sg.overallScore.toFixed(2)}  anchor=${(f.imdbRating ?? 7.0).toFixed(2)}  delta=${Math.abs(sg.overallScore - (f.imdbRating ?? 7.0)).toFixed(3)}`)
  }

  // ─── (8) Spot-check 10 films for dual labels (random) ──────────────────────
  console.log('\n=== (8) SPOT-CHECK 10 RANDOM FILMS ===')
  const shuffled = [...records].sort(() => Math.random() - 0.5).slice(0, 10)
  let spotOk = true
  for (const r of shuffled) {
    const ok = r.allBeatsDual && r.peakOk && r.lowOk
    if (!ok) spotOk = false
    console.log(`  [${r.bucket}] ${r.id} "${r.title}": beats ${r.beatsWithBoth}/${r.beatCount} peak=${r.peakOk ? 'OK' : 'FAIL'} low=${r.lowOk ? 'OK' : 'FAIL'}  ${ok ? '✓' : '✗'}`)
  }
  console.log(`  → ${spotOk ? 'ALL OK' : 'FAILURES ABOVE'}`)

  // ─── (9) Marvel One-Shot: Item 47 (bucket d) check ─────────────────────────
  console.log('\n=== (9) MARVEL ONE-SHOT: Item 47 (bucket d) ===')
  const item47 = records.find((r) => r.id === 'cmnyy9vl200ta04kwc4faz0ok')
  if (item47) {
    console.log(`  ${item47.id} "${item47.title}": beats=${item47.beatCount} score=${item47.overallScore?.toFixed(2)} dualAllBeats=${item47.allBeatsDual}`)
    console.log(`  (built-log classified as hybrid, plotLength=674 — below 1500 threshold but non-empty)`)
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
