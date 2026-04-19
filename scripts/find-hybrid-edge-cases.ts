/**
 * One-off: surface candidate filmIds for hybrid edge-case testing.
 * Profiles: (1) 3-4 quality reviews, (2) Wikipedia plot 500-1500 chars,
 * (3) no existing SentimentGraph. See user-specified rules for fallbacks.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import { isQualityReview } from '../src/lib/sentiment-pipeline'
import { fetchWikipediaPlot } from '../src/lib/sources/wikipedia'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

interface FilmSummary {
  id: string
  title: string
  year: number | null
  runtime: number | null
  qualityCount: number
  hasGraph: boolean
  prerelease: boolean
}

async function main() {
  const films = await prisma.film.findMany({
    include: {
      reviews: { select: { reviewText: true } },
      sentimentGraph: { select: { id: true } },
    },
    orderBy: { title: 'asc' },
  })
  console.log(`Loaded ${films.length} films`)

  const now = new Date()
  const summaries: FilmSummary[] = films.map((f) => ({
    id: f.id,
    title: f.title,
    year: f.releaseDate ? new Date(f.releaseDate).getFullYear() : null,
    runtime: f.runtime,
    qualityCount: f.reviews.filter((r) => isQualityReview(r.reviewText)).length,
    hasGraph: f.sentimentGraph !== null,
    prerelease: f.releaseDate !== null && f.releaseDate > now,
  }))

  const noGraph = summaries.filter((s) => !s.hasGraph)
  const prereleaseCount = summaries.filter((s) => s.prerelease).length
  console.log(`Pre-flight: total=${summaries.length} prerelease=${prereleaseCount} noGraph=${noGraph.length}`)

  // ── Candidate 1: 3-4 quality reviews, prefer; fall back to 3-5 ─────────────
  const exact34 = summaries.filter((s) => s.qualityCount === 3 || s.qualityCount === 4)
  const ext35 = summaries.filter((s) => s.qualityCount >= 3 && s.qualityCount <= 5)
  console.log(`\n[Cand 1] exact 3-4: ${exact34.length} | 3-5: ${ext35.length}`)
  const cand1 = exact34.sort((a, b) => a.title.localeCompare(b.title))[0] ?? ext35[0]
  console.log(`[Cand 1] pick: ${cand1?.id} "${cand1?.title}" (${cand1?.year}) quality=${cand1?.qualityCount} hasGraph=${cand1?.hasGraph} prerelease=${cand1?.prerelease}`)

  // ── Candidate 2: Wikipedia plot 500-1500 chars. Probe up to 5. ─────────────
  // Restrict to films with enough reviews so hybrid would actually run.
  // Skip cand1/cand3 candidates.
  const probeStart = summaries
    .filter((s) => s.qualityCount >= 3 && s.year !== null && !s.prerelease)
    // Start probes from the middle of the list for title diversity.
    .sort((a, b) => a.title.localeCompare(b.title))
  const midpoint = Math.floor(probeStart.length / 2)
  const probeOrder = [
    ...probeStart.slice(midpoint),
    ...probeStart.slice(0, midpoint),
  ]

  let cand2: (FilmSummary & { plotLength: number }) | null = null
  const probeLog: string[] = []
  for (const s of probeOrder) {
    if (cand2) break
    if (s.id === cand1?.id) continue
    const plot = await fetchWikipediaPlot(s.title, s.year!)
    const len = plot?.length ?? 0
    probeLog.push(`  ${s.title} (${s.year}) plot=${len}`)
    if (probeLog.length >= 5 && !cand2) break
    if (plot && len >= 500 && len <= 1500) {
      cand2 = { ...s, plotLength: len }
    }
  }
  console.log(`\n[Cand 2] probes:`)
  probeLog.forEach((l) => console.log(l))
  if (cand2) {
    console.log(`[Cand 2] pick: ${cand2.id} "${cand2.title}" (${cand2.year}) plotLen=${cand2.plotLength} quality=${cand2.qualityCount}`)
  } else {
    console.log(`[Cand 2] no plot in range after ${probeLog.length} probes; falling back to non-English-title film`)
    // Fallback: look for films whose title is clearly non-English (has non-ASCII chars)
    const nonEnglish = summaries.filter(
      (s) => s.qualityCount >= 3 && s.year !== null && !s.prerelease && /[^\x00-\x7F]/.test(s.title)
    )
    const fallback = nonEnglish[0]
    if (fallback) {
      console.log(`[Cand 2] fallback: ${fallback.id} "${fallback.title}" (${fallback.year}) quality=${fallback.qualityCount}`)
      cand2 = { ...fallback, plotLength: 0 }
    }
  }

  // ── Candidate 3: no SentimentGraph. Prefer one with ≥3 quality reviews. ────
  const noGraphRunnable = noGraph.filter((s) => s.qualityCount >= 3 && !s.prerelease)
  const noGraphBelowThreshold = noGraph.filter((s) => s.qualityCount < 3 && !s.prerelease)
  console.log(`\n[Cand 3] noGraph runnable (≥3 quality): ${noGraphRunnable.length} | below threshold: ${noGraphBelowThreshold.length}`)
  const cand3 =
    noGraphRunnable.sort((a, b) => a.qualityCount - b.qualityCount)[0] ??
    noGraphBelowThreshold[0]
  console.log(`[Cand 3] pick: ${cand3?.id} "${cand3?.title}" (${cand3?.year}) quality=${cand3?.qualityCount} hasGraph=${cand3?.hasGraph} willSkip=${cand3 ? cand3.qualityCount < 3 : 'n/a'}`)

  console.log(`\n=== PICKS ===`)
  console.log(`Cand 1: ${cand1?.id}  "${cand1?.title}"`)
  console.log(`Cand 2: ${cand2?.id}  "${cand2?.title}"`)
  console.log(`Cand 3: ${cand3?.id}  "${cand3?.title}"`)
  console.log(`\nInvoke:\nnpx tsx scripts/test-hybrid.ts ${cand1?.id} ${cand2?.id} ${cand3?.id} --allow-prerelease`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
