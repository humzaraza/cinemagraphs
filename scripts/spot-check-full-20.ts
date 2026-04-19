/**
 * One-off: 20 random DB spot-checks after the full 1,339 bulk regen.
 * For each: confirms dual labels on every beat, peak, and lowest moment;
 * prints beat count, generatedAt, and anchor delta.
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

interface Beat {
  label?: unknown
  labelFull?: unknown
}

function dualOk(b: Beat): boolean {
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
  // Pick 20 random films that have a SentimentGraph and are not pre-release
  // and not skipped-no-reviews. Sample from the post-run success population.
  const pool = await prisma.film.findMany({
    where: { sentimentGraph: { isNot: null } },
    include: { sentimentGraph: true },
  })
  console.log(`Pool: ${pool.length} films with SentimentGraph`)

  // Fisher–Yates shuffle, take 20
  const copy = [...pool]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  const sample = copy.slice(0, 20)

  let allOk = true
  let totalBeats = 0
  let totalDualBeats = 0
  for (const f of sample) {
    const sg = f.sentimentGraph!
    const beats = (Array.isArray(sg.dataPoints) ? (sg.dataPoints as unknown as Beat[]) : []) as Beat[]
    const dualBeats = beats.filter(dualOk).length
    const allBeatsDual = beats.length > 0 && dualBeats === beats.length
    const peakOk = momentOk(sg.peakMoment)
    const lowOk = momentOk(sg.lowestMoment)
    const ok = allBeatsDual && peakOk && lowOk
    if (!ok) allOk = false
    totalBeats += beats.length
    totalDualBeats += dualBeats

    const anchor = f.imdbRating ?? 7.0
    const delta = Math.abs(sg.overallScore - anchor)

    console.log(
      `  [${ok ? '✓' : '✗'}] ${f.id} "${f.title.slice(0, 50)}"  ` +
        `beats=${dualBeats}/${beats.length} peak=${peakOk ? 'OK' : 'FAIL'} low=${lowOk ? 'OK' : 'FAIL'}  ` +
        `score=${sg.overallScore.toFixed(2)} anchor=${anchor.toFixed(2)} Δ=${delta.toFixed(2)}  ` +
        `generatedAt=${sg.generatedAt.toISOString().slice(0, 19)}`
    )
  }

  console.log('')
  console.log(`Totals: beats=${totalBeats} dualBeats=${totalDualBeats}  ${totalBeats === totalDualBeats ? '100% dual' : 'MISSING DUAL'}`)
  console.log(allOk ? '✓ SPOT-CHECK 20: ALL PASS' : '✗ SPOT-CHECK 20: FAILURES ABOVE')

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
