// Phase C1 verification: render all 8 slides in both formats against PHM-shaped
// hardcoded data and save PNGs so a human can eyeball the output. Background
// images use the synthetic placeholder (no TMDB call — that's C5).
//
// Run: npx tsx scripts/verify-slide-composer.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { composeSlide } from '../src/lib/carousel/slide-composer.ts'

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

const PHM_FILM = {
  title: 'Project Hail Mary',
  year: 2026,
  runtime: '2h 37m',
  genres: ['Sci-Fi', 'Drama'],
  criticsScore: 8.3,
  dataPoints: PHM_DATA,
  totalRuntimeMinutes: 157,
}

// Per-slide middle content pulled from docs/carousel/carousel-structure-ig-4x5.html.
// highlightBeatIndex is computed against the post-anchor point order
// (renderGraph prepends a neutral anchor at index 0, so PHM index N becomes N+1).
const MIDDLE = {
  2: {
    pillLabel: 'THE OPENING · 0M-5M',
    headline: 'Straight into the mystery.',
    bodyCopy:
      'Ryland wakes up on a spaceship light-years from Earth with no memory. The audience is locked in before minute 5. The score hits 7.8 almost immediately.',
    highlightBeatIndex: 1,
  },
  3: {
    pillLabel: 'THE SETUP · 15M-55M',
    headline: 'Then the science kicks in.',
    bodyCopy:
      'A slow build through the first hour. Petrova Line. Astrophage. Recruitment. Audiences are patient but not gripped. The score hovers in the 7s for forty minutes.',
    highlightBeatIndex: 6,
  },
  4: {
    pillLabel: 'THE DROP · 1H 15M',
    headline: 'Then everything crashes.',
    bodyCopy:
      'At 1h 15m the score bottoms out at 5.8. The only red dot in the film. Eva Stratt drugs Ryland and forces him onto the ship. Audiences hate it, even knowing the plot needs it.',
    highlightBeatIndex: 8,
  },
  5: {
    pillLabel: 'FIRST CONTACT · 1H 25M',
    headline: 'Then Rocky shows up.',
    bodyCopy:
      "A 2.9 point jump in ten minutes. Rocky's alien spacecraft at Tau Ceti. The film transforms from cold thriller into something warmer.",
    highlightBeatIndex: 9,
  },
  6: {
    pillLabel: 'THE PEAK · 1H 55M',
    headline: "The film's highest moment.",
    bodyCopy:
      "Rocky breaks his spacesuit to save unconscious Ryland. The score hits 9.5. You don't get this high without the 5.8 that came before it.",
    highlightBeatIndex: 12,
  },
  7: {
    pillLabel: 'THE ENDING · 2H 34M',
    headline: 'It pulls back on purpose.',
    bodyCopy:
      "Ryland stays behind on Erid. No hero's return. The ending drops to 7.4, the largest pullback of the final act. Not disappointment. A deliberate, bittersweet landing.",
    highlightBeatIndex: 16,
  },
}

const OUT_DIR = resolve(process.cwd(), 'slide-composer-output')
mkdirSync(OUT_DIR, { recursive: true })

const formats = ['4x5', '9x16']
const slideNumbers = [1, 2, 3, 4, 5, 6, 7, 8]

const results = []
for (const format of formats) {
  for (const slideNumber of slideNumbers) {
    const t0 = performance.now()
    const input = {
      film: PHM_FILM,
      slideNumber,
      format,
    }
    if (slideNumber >= 2 && slideNumber <= 7) {
      input.middleContent = MIDDLE[slideNumber]
    }
    const png = await composeSlide(input)
    const ms = +(performance.now() - t0).toFixed(1)
    const label = `slide-${String(slideNumber).padStart(2, '0')}_${format}`
    const outPath = join(OUT_DIR, `${label}.png`)
    writeFileSync(outPath, png)
    results.push({ label, path: outPath, ms, bytes: png.length })
    console.log(
      `  ${label.padEnd(20)}  ${ms.toString().padStart(7)}ms  ${(png.length / 1024).toFixed(1).padStart(7)} KB  ${outPath}`,
    )
  }
}

const totalMs = results.reduce((acc, r) => acc + r.ms, 0).toFixed(1)

console.log('\n=== SUMMARY ===')
for (const r of results) {
  console.log(`${r.label.padEnd(20)}  ${r.ms.toString().padStart(7)}ms  ${r.path}`)
}
console.log(`\n${results.length} PNGs written in ${totalMs}ms total.`)
