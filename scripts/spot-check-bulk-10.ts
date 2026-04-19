/**
 * One-off: verify bulk-regen-hybrid Step B rerun wrote dual-label beats.
 * Picks 3 random film ids from the 10 submitted, prints beat count,
 * peak/lowest labels, overallScore vs anchor, and samples 2 beats.
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

const ALL_IDS = [
  'cmn17kvfg0000mmcftuo7mibu',
  'cmn17kvo40001mmcf8gx7tpbz',
  'cmn17kvsx0002mmcfk2wpnvcu',
  'cmn17kvzd0003mmcfmlt49j26',
  'cmn17kw820004mmcfjo1rcv0h',
  'cmn17kwcz0005mmcftsaot0m2',
  'cmn17kwko0006mmcfnhc0cveg',
  'cmn17kwpz0007mmcf967q70s2',
  'cmn17kwwt0008mmcfu8s2d6en',
  'cmn17kx320009mmcf290309k0',
]

function pick3Random<T>(arr: T[]): T[] {
  const copy = [...arr]
  const out: T[] = []
  for (let i = 0; i < 3; i++) {
    const idx = Math.floor(Math.random() * copy.length)
    out.push(copy.splice(idx, 1)[0])
  }
  return out
}

// Matches buildAnchorString() in src/lib/hybrid-sentiment.ts:48 — the prompt
// pins `target` to `film.imdbRating || 7.0`, not an average of all sources.
function anchorTarget(film: { imdbRating: number | null }): number {
  return film.imdbRating ?? 7.0
}

interface Beat {
  label?: unknown
  labelFull?: unknown
  timeStart?: unknown
  timeEnd?: unknown
  score?: unknown
}

async function main() {
  const ids = pick3Random(ALL_IDS)
  console.log(`Sampling 3 of 10:`, ids)
  console.log('')

  let globalOk = true

  for (const id of ids) {
    const film = await prisma.film.findUnique({
      where: { id },
      include: { sentimentGraph: true },
    })
    if (!film) {
      console.log(`[${id}] NOT FOUND`)
      globalOk = false
      continue
    }
    const sg = film.sentimentGraph
    if (!sg) {
      console.log(`[${id}] "${film.title}" — NO SENTIMENT GRAPH`)
      globalOk = false
      continue
    }

    const anchor = anchorTarget(film)
    const anchorDelta = Math.abs(sg.overallScore - anchor)
    const withinAnchor = anchorDelta <= 0.2

    const raw = sg.dataPoints as unknown
    const beats = (Array.isArray(raw) ? raw : []) as Beat[]
    const beatCount = beats.length
    const beatsWithBoth = beats.filter(
      (b) =>
        typeof b.label === 'string' &&
        (b.label as string).trim() !== '' &&
        typeof b.labelFull === 'string' &&
        (b.labelFull as string).trim() !== ''
    ).length
    const allBeatsDual = beatCount > 0 && beatsWithBoth === beatCount

    const peak = sg.peakMoment as { label?: unknown; labelFull?: unknown } | null
    const low = sg.lowestMoment as { label?: unknown; labelFull?: unknown } | null
    const peakOk =
      peak !== null &&
      typeof peak.label === 'string' &&
      (peak.label as string).trim() !== '' &&
      typeof peak.labelFull === 'string' &&
      (peak.labelFull as string).trim() !== ''
    const lowOk =
      low !== null &&
      typeof low.label === 'string' &&
      (low.label as string).trim() !== '' &&
      typeof low.labelFull === 'string' &&
      (low.labelFull as string).trim() !== ''

    console.log(`[${id}] "${film.title}" (${film.releaseDate?.toISOString().slice(0, 10) ?? '?'})`)
    console.log(`  generatedAt        : ${sg.generatedAt.toISOString()}`)
    console.log(`  version            : ${sg.version}`)
    console.log(`  beats              : ${beatCount}`)
    console.log(`  beats dual-labeled : ${beatsWithBoth}/${beatCount}  ${allBeatsDual ? 'OK' : 'FAIL'}`)
    console.log(`  peakMoment labels  : ${peakOk ? 'OK' : 'FAIL'}  (label="${(peak?.label as string) ?? ''}" | labelFull="${(peak?.labelFull as string) ?? ''}")`)
    console.log(`  lowestMoment labels: ${lowOk ? 'OK' : 'FAIL'}  (label="${(low?.label as string) ?? ''}" | labelFull="${(low?.labelFull as string) ?? ''}")`)
    console.log(`  overallScore       : ${sg.overallScore.toFixed(2)}`)
    console.log(`  anchor target      : ${anchor.toFixed(2)}  (imdbRating=${film.imdbRating ?? 'null'} → falls back to 7.0)  delta=${anchorDelta.toFixed(2)}  withinAnchor(±0.2)=${withinAnchor}`)

    const sample = beats.slice(0, 2)
    for (let i = 0; i < sample.length; i++) {
      const b = sample[i]
      console.log(`  beat[${i}]            : label="${String(b.label ?? '')}" | labelFull="${String(b.labelFull ?? '')}"`)
    }
    console.log('')

    if (!allBeatsDual || !peakOk || !lowOk) globalOk = false
  }

  console.log(globalOk ? 'SPOT CHECK: ALL OK' : 'SPOT CHECK: FAILURES ABOVE')
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
