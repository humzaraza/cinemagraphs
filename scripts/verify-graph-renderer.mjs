// Phase B verification: render the four target graphs against PHM-shaped data
// and save PNGs so a human can eyeball the output.
//
// Run: npx tsx scripts/verify-graph-renderer.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { renderGraph } from '../src/lib/carousel/graph-renderer.ts'

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
const TOTAL_RUNTIME = 157
const CRITICS_SCORE = 8.3
// After prependNeutralAnchor, the peak at t=115 (s=9.5) is index 12.
const PEAK_INDEX = 12

const OUT_DIR = resolve(process.cwd(), 'graph-renderer-output')
mkdirSync(OUT_DIR, { recursive: true })

const cases = [
  {
    label: '4x5_default',
    width: 1080,
    height: 540,
    format: '4x5',
    highlightBeatIndex: undefined,
  },
  {
    label: '4x5_highlight',
    width: 1080,
    height: 540,
    format: '4x5',
    highlightBeatIndex: PEAK_INDEX,
  },
  {
    label: '9x16_default',
    width: 1080,
    height: 1152,
    format: '9x16',
    highlightBeatIndex: undefined,
  },
  {
    label: '9x16_highlight',
    width: 1080,
    height: 1152,
    format: '9x16',
    highlightBeatIndex: PEAK_INDEX,
  },
]

const results = []
for (const c of cases) {
  const t0 = performance.now()
  const { png } = renderGraph({
    dataPoints: PHM_DATA,
    totalRuntime: TOTAL_RUNTIME,
    criticsScore: CRITICS_SCORE,
    width: c.width,
    height: c.height,
    format: c.format,
    highlightBeatIndex: c.highlightBeatIndex,
  })
  const ms = +(performance.now() - t0).toFixed(1)
  const outPath = join(OUT_DIR, `${c.label}.png`)
  writeFileSync(outPath, png)
  results.push({ label: c.label, path: outPath, ms, bytes: png.length })
  console.log(`  ${c.label.padEnd(16)}  ${ms.toString().padStart(6)}ms  ${(png.length / 1024).toFixed(1)} KB  ${outPath}`)
}

console.log('\n=== SUMMARY ===')
for (const r of results) {
  console.log(`${r.label.padEnd(16)}  ${r.ms.toString().padStart(6)}ms  ${r.path}`)
}
