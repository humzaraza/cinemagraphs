// Phase C2-AI verification: call the real Anthropic API with PHM-shaped data
// and print the generated body copy, characteristics, token usage, and cost.
//
// Run: npx tsx scripts/verify-body-copy-generator.mjs

import dotenv from 'dotenv'
import { performance } from 'node:perf_hooks'

// Load .env.local first (local dev convention in this repo), then .env as fallback.
dotenv.config({ path: '.env.local' })
dotenv.config()

import {
  BODY_COPY_MODEL,
  generateBodyCopy,
} from '../src/lib/carousel/body-copy-generator.ts'

// ── Same PHM data the slide-composer verification script uses ────────────

const PHM_DATA = [
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

const PHM_SLIDES = [
  { slideNumber: 2, pillLabel: 'THE OPENING · 0M-5M', beatTimestamp: 5, beatScore: 7.8, beatColor: 'gold' },
  { slideNumber: 3, pillLabel: 'THE SETUP · 15M-55M', beatTimestamp: 55, beatScore: 8.1, beatColor: 'teal' },
  { slideNumber: 4, pillLabel: 'THE DROP · 1H 15M', beatTimestamp: 75, beatScore: 5.8, beatColor: 'red' },
  { slideNumber: 5, pillLabel: 'FIRST CONTACT · 1H 25M', beatTimestamp: 85, beatScore: 8.7, beatColor: 'teal' },
  { slideNumber: 6, pillLabel: 'THE PEAK · 1H 55M', beatTimestamp: 115, beatScore: 9.5, beatColor: 'teal' },
  { slideNumber: 7, pillLabel: 'THE ENDING · 2H 34M', beatTimestamp: 154, beatScore: 7.4, beatColor: 'gold' },
]

const INPUT = {
  filmTitle: 'Project Hail Mary',
  filmYear: 2026,
  runtimeMinutes: 157,
  criticsScore: 8.3,
  dataPoints: PHM_DATA,
  slides: PHM_SLIDES,
}

// Sonnet 4.x pricing (USD per 1M tokens). Kept local to the script so the
// production module stays focused on generation, not billing math.
const PRICE_INPUT = 3.0
const PRICE_OUTPUT = 15.0

function approxCostUsd(totalTokens) {
  // We don't have a split here; assume a 5:1 input/output ratio for a rough estimate.
  const inputShare = 5 / 6
  const outputShare = 1 / 6
  return (
    (totalTokens * inputShare * PRICE_INPUT +
      totalTokens * outputShare * PRICE_OUTPUT) /
    1_000_000
  )
}

if (!process.env.ANTHROPIC_API_KEY && !process.env.CINEMA_ANTHROPIC_KEY) {
  console.error('ANTHROPIC_API_KEY (or CINEMA_ANTHROPIC_KEY) not set in env.')
  process.exit(1)
}

const t0 = performance.now()
const result = await generateBodyCopy(INPUT)
const elapsedMs = +(performance.now() - t0).toFixed(1)

console.log(`\nModel:            ${result.modelUsed}`)
console.log(`Expected model:   ${BODY_COPY_MODEL}`)
console.log(`Total tokens:     ${result.totalTokens}`)
console.log(`Approx cost USD:  $${approxCostUsd(result.totalTokens).toFixed(5)}`)
console.log(`Elapsed:          ${elapsedMs}ms`)

console.log('\n=== CHARACTERISTICS ===')
console.log(JSON.stringify(result.characteristics, null, 2))

console.log('\n=== GENERATED BODY COPY ===')
for (const slide of PHM_SLIDES) {
  const copy = result.bodyCopy[slide.slideNumber]
  console.log(`\n--- Slide ${slide.slideNumber} (${slide.pillLabel}, beat t=${slide.beatTimestamp} s=${slide.beatScore}) ---`)
  console.log(copy)
}

console.log('\n=== DONE ===')
