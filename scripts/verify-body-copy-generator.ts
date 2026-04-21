// Phase C2-AI verification: call the real Anthropic API with PHM-shaped data
// and print the generated body copy, characteristics, token usage, and cost.
//
// Run: npm run verify:body-copy-generator
//  or: npx tsx scripts/verify-body-copy-generator.ts

import dotenv from 'dotenv'
import { performance } from 'node:perf_hooks'

// Load .env.local first (local dev convention in this repo), then .env as fallback.
dotenv.config({ path: '.env.local' })
dotenv.config()

import {
  BODY_COPY_MODEL,
  generateBodyCopy,
  type GenerateBodyCopyInput,
  type SlideBeatContext,
} from '../src/lib/carousel/body-copy-generator'
import type { DataPoint } from '../src/lib/carousel/graph-renderer'

const PHM_DATA: DataPoint[] = [
  { t: 5, s: 7.8 },
  { t: 15, s: 7.2 },
  { t: 25, s: 6.8 },
  { t: 35, s: 7.5 },
  { t: 45, s: 7.9 },
  { t: 55, s: 8.1 },
  { t: 65, s: 6.2 },
  { t: 75, s: 5.8 },
  { t: 85, s: 8.7 },
  { t: 95, s: 9.2 },
  { t: 105, s: 8.9 },
  { t: 115, s: 9.5 },
  { t: 125, s: 8.6 },
  { t: 135, s: 9.1 },
  { t: 145, s: 8.8 },
  { t: 154, s: 7.4 },
]

const PHM_SLIDES: SlideBeatContext[] = [
  {
    slideNumber: 2,
    pillLabel: 'THE OPENING',
    beatTimestamp: 5,
    beatScore: 7.8,
    beatColor: 'gold',
    originalRole: 'opening',
    storyBeatName: 'Ryland wakes up alone on the Hail Mary',
  },
  {
    slideNumber: 3,
    pillLabel: 'THE SETUP',
    beatTimestamp: 55,
    beatScore: 8.1,
    beatColor: 'teal',
    originalRole: 'setup',
    storyBeatName: 'Eva Stratt reveals the suicide mission to Tau Ceti',
  },
  {
    slideNumber: 4,
    pillLabel: 'THE DROP',
    beatTimestamp: 75,
    beatScore: 5.8,
    beatColor: 'red',
    originalRole: 'drop',
    storyBeatName: 'Grace is drugged and forcibly loaded onto Hail Mary',
  },
  {
    slideNumber: 5,
    pillLabel: 'RECOVERY',
    beatTimestamp: 85,
    beatScore: 8.7,
    beatColor: 'teal',
    originalRole: 'recovery',
    storyBeatName: "Rocky's spacecraft appears at Tau Ceti",
  },
  {
    slideNumber: 6,
    pillLabel: 'THE PEAK',
    beatTimestamp: 115,
    beatScore: 9.5,
    beatColor: 'teal',
    originalRole: 'peak',
    storyBeatName: 'Rocky breaks his spacesuit to save unconscious Grace',
  },
  {
    slideNumber: 7,
    pillLabel: 'THE ENDING',
    beatTimestamp: 154,
    beatScore: 7.4,
    beatColor: 'gold',
    originalRole: 'ending',
    storyBeatName: 'Grace teaches alien children on Erid',
  },
]

const PHM_INPUT: GenerateBodyCopyInput = {
  filmTitle: 'Project Hail Mary',
  filmYear: 2026,
  runtimeMinutes: 157,
  criticsScore: 8.3,
  dataPoints: PHM_DATA,
  slides: PHM_SLIDES,
}

// Obscure/fake film used as a diagnostic: verify that body-copy voice still
// reads like the reference PHM copy when the model can't lean on training-data
// plot knowledge. Data shape chosen to be generic (small drop, recovery, peak,
// gentle pullback) so the model has to work from the graph, not the title.
const LIGHTHOUSE_DATA: DataPoint[] = [
  { t: 8, s: 6.5 },
  { t: 18, s: 7.1 },
  { t: 28, s: 7.4 },
  { t: 38, s: 6.8 },
  { t: 48, s: 7.6 },
  { t: 58, s: 8.0 },
  { t: 68, s: 6.2 },
  { t: 78, s: 7.5 },
  { t: 88, s: 8.2 },
  { t: 98, s: 7.7 },
  { t: 107, s: 7.0 },
]

// Lighthouse is a fake film — leave storyBeatName blank so the model falls
// back to the generic role label for the pill. This exercises the fallback
// path alongside the real-film path.
const LIGHTHOUSE_SLIDES: SlideBeatContext[] = [
  {
    slideNumber: 2,
    pillLabel: 'THE OPENING',
    beatTimestamp: 8,
    beatScore: 6.5,
    beatColor: 'gold',
    originalRole: 'opening',
    storyBeatName: '',
  },
  {
    slideNumber: 3,
    pillLabel: 'THE SETUP',
    beatTimestamp: 58,
    beatScore: 8.0,
    beatColor: 'teal',
    originalRole: 'setup',
    storyBeatName: '',
  },
  {
    slideNumber: 4,
    pillLabel: 'THE DROP',
    beatTimestamp: 68,
    beatScore: 6.2,
    beatColor: 'gold',
    originalRole: 'drop',
    storyBeatName: '',
  },
  {
    slideNumber: 5,
    pillLabel: 'RECOVERY',
    beatTimestamp: 78,
    beatScore: 7.5,
    beatColor: 'gold',
    originalRole: 'recovery',
    storyBeatName: '',
  },
  {
    slideNumber: 6,
    pillLabel: 'THE PEAK',
    beatTimestamp: 88,
    beatScore: 8.2,
    beatColor: 'teal',
    originalRole: 'peak',
    storyBeatName: '',
  },
  {
    slideNumber: 7,
    pillLabel: 'THE ENDING',
    beatTimestamp: 107,
    beatScore: 7.0,
    beatColor: 'gold',
    originalRole: 'ending',
    storyBeatName: '',
  },
]

const LIGHTHOUSE_INPUT: GenerateBodyCopyInput = {
  filmTitle: 'The Last Lighthouse',
  filmYear: 2019,
  runtimeMinutes: 107,
  criticsScore: 7.2,
  dataPoints: LIGHTHOUSE_DATA,
  slides: LIGHTHOUSE_SLIDES,
}

const FILMS: Record<string, GenerateBodyCopyInput> = {
  phm: PHM_INPUT,
  lighthouse: LIGHTHOUSE_INPUT,
}

const filmKey = (process.argv[2] || 'phm').toLowerCase()
const INPUT = FILMS[filmKey]
if (!INPUT) {
  console.error(`Unknown film key: ${filmKey}. Known: ${Object.keys(FILMS).join(', ')}`)
  process.exit(1)
}

// Sonnet 4.x pricing (USD per 1M tokens). Kept local to the script so the
// production module stays focused on generation, not billing math.
const PRICE_INPUT = 3.0
const PRICE_OUTPUT = 15.0

function approxCostUsd(totalTokens: number): number {
  // We don't have a split here; assume a 5:1 input/output ratio for a rough estimate.
  const inputShare = 5 / 6
  const outputShare = 1 / 6
  return (
    (totalTokens * inputShare * PRICE_INPUT +
      totalTokens * outputShare * PRICE_OUTPUT) /
    1_000_000
  )
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CINEMA_ANTHROPIC_KEY) {
    console.error('ANTHROPIC_API_KEY (or CINEMA_ANTHROPIC_KEY) not set in env.')
    process.exit(1)
  }

  const t0 = performance.now()
  const result = await generateBodyCopy(INPUT)
  const elapsedMs = +(performance.now() - t0).toFixed(1)

  console.log(`\nFilm:             ${INPUT.filmTitle} (${INPUT.filmYear})`)
  console.log(`Model:            ${result.modelUsed}`)
  console.log(`Expected model:   ${BODY_COPY_MODEL}`)
  console.log(`Total tokens:     ${result.totalTokens}`)
  console.log(`Approx cost USD:  $${approxCostUsd(result.totalTokens).toFixed(5)}`)
  console.log(`Elapsed:          ${elapsedMs}ms`)

  console.log('\n=== CHARACTERISTICS ===')
  console.log(JSON.stringify(result.characteristics, null, 2))

  console.log('\n=== GENERATED BODY COPY ===')
  for (const slide of INPUT.slides) {
    const copy = result.slideCopy[slide.slideNumber]
    console.log(`\n--- Slide ${slide.slideNumber} (role=${slide.originalRole}, beat t=${slide.beatTimestamp} s=${slide.beatScore}) ---`)
    console.log(`pill: ${copy?.pill ?? '(missing)'}`)
    console.log(`body: ${copy?.body ?? '(missing)'}`)
  }

  console.log('\n=== DONE ===')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
