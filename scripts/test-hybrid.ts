/**
 * Three-column comparison for hybrid-sentiment validation.
 *
 * Usage: npx tsx scripts/test-hybrid.ts <filmId1> <filmId2> ...
 *
 * Writes full output to hybrid-test-output.txt in the repo root.
 * Does not write to the database.
 *
 * NOTE on module evaluation order: Any module that reads `process.env` at
 * load time (prisma.ts, hybrid-sentiment.ts, claude.ts) MUST be loaded after
 * dotenv has populated env. ES modules evaluate all static imports before the
 * importing module's top-level code runs, so those modules are loaded via
 * dynamic `await import(...)` inside `main()` — after the top-level
 * `dotenvConfig(...)` call below has run.
 */
import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: ['.env.local', '.env'] })

import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import { writeFileSync, appendFileSync } from 'fs'
import { resolve } from 'path'
import type { SentimentDataPoint } from '../src/lib/types'
import type { StoryBeat } from '../src/lib/beat-generator'
import type { HybridResult } from '../src/lib/hybrid-sentiment'

const COL_WIDTH = 58

const outputPath = resolve(process.cwd(), 'hybrid-test-output.txt')
writeFileSync(outputPath, '')

function write(line = ''): void {
  console.log(line)
  appendFileSync(outputPath, line + '\n')
}

function padRight(str: string, n: number): string {
  if (str.length === n) return str
  if (str.length > n) return str.slice(0, n - 1) + '…'
  return str + ' '.repeat(n - str.length)
}

const PROMPT_PLOT_HEAD = 500
const PROMPT_PLOT_TAIL = 200

/**
 * Truncate the Plot Summary section of a hybrid-prompt user string for printing.
 * Leaves the rest of the prompt (film info, anchor, reviews, anti-patterns,
 * output schema) verbatim so reviewers can spot prompt bugs.
 */
function truncatePlotSection(userPrompt: string): string {
  const startMarker = '## Plot Summary (ground truth for events, chronology, characters)\n\n'
  const endMarker = '\n\n## Reviews'
  const startIdx = userPrompt.indexOf(startMarker)
  if (startIdx === -1) return userPrompt
  const plotStart = startIdx + startMarker.length
  const endIdx = userPrompt.indexOf(endMarker, plotStart)
  if (endIdx === -1) return userPrompt
  const plot = userPrompt.slice(plotStart, endIdx)
  if (plot.length <= PROMPT_PLOT_HEAD + PROMPT_PLOT_TAIL + 30) return userPrompt
  const omitted = plot.length - PROMPT_PLOT_HEAD - PROMPT_PLOT_TAIL
  const truncated =
    plot.slice(0, PROMPT_PLOT_HEAD) +
    `\n\n...[${omitted} chars of plot omitted]...\n\n` +
    plot.slice(plot.length - PROMPT_PLOT_TAIL)
  return userPrompt.slice(0, plotStart) + truncated + userPrompt.slice(endIdx)
}

function formatTime(start?: number, end?: number): string {
  if (typeof start !== 'number' || typeof end !== 'number') return '      '
  const s = Math.round(start).toString().padStart(3, ' ')
  const e = Math.round(end).toString().padStart(3, ' ')
  return `[${s}-${e}m]`
}

function formatBeatRow(beat: { label: string; timeStart: number; timeEnd: number; score?: number | null }): string {
  const time = formatTime(beat.timeStart, beat.timeEnd)
  const scoreSuffix = typeof beat.score === 'number' ? ` (${beat.score.toFixed(1)})` : ''
  return `${time} ${beat.label}${scoreSuffix}`
}

function normalizeCurrentBeat(raw: unknown): SentimentDataPoint | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  if (typeof b.label !== 'string') return null
  if (typeof b.timeStart !== 'number' || typeof b.timeEnd !== 'number') return null
  return b as unknown as SentimentDataPoint
}

interface Deps {
  prisma: typeof import('../src/lib/prisma').prisma
  isQualityReview: typeof import('../src/lib/sentiment-pipeline').isQualityReview
  fetchWikipediaPlot: typeof import('../src/lib/sources/wikipedia').fetchWikipediaPlot
  generateBeatsFromPlot: typeof import('../src/lib/beat-generator').generateBeatsFromPlot
  generateHybridSentimentGraph: typeof import('../src/lib/hybrid-sentiment').generateHybridSentimentGraph
}

async function runOne(filmId: string, deps: Deps): Promise<void> {
  const { prisma, isQualityReview, fetchWikipediaPlot, generateBeatsFromPlot, generateHybridSentimentGraph } = deps

  write('━'.repeat(COL_WIDTH * 3 + 6))
  write(`FILM ID: ${filmId}`)
  write('━'.repeat(COL_WIDTH * 3 + 6))

  const film = await prisma.film.findUnique({
    where: { id: filmId },
    include: { sentimentGraph: true },
  })
  if (!film) {
    write(`ERROR: film not found in database`)
    write('')
    return
  }

  const allReviews = await prisma.review.findMany({ where: { filmId } })
  const qualityCount = allReviews.filter((r) => isQualityReview(r.reviewText)).length

  const releaseYear = film.releaseDate ? new Date(film.releaseDate).getFullYear() : null
  const runtime = film.runtime || 120

  write(`Title        : ${film.title}${releaseYear ? ` (${releaseYear})` : ''}`)
  write(`Runtime      : ${runtime} min`)
  write(`Release date : ${film.releaseDate ? film.releaseDate.toISOString().slice(0, 10) : 'unknown'}`)
  write(`Reviews (all): ${allReviews.length}`)
  write(`Reviews (Q)  : ${qualityCount}`)
  write('')

  // Column 1: Current beats from DB
  const currentBeats: SentimentDataPoint[] = []
  if (film.sentimentGraph?.dataPoints) {
    const rawArr = film.sentimentGraph.dataPoints as unknown
    if (Array.isArray(rawArr)) {
      for (const raw of rawArr) {
        const b = normalizeCurrentBeat(raw)
        if (b) currentBeats.push(b)
      }
    }
  }

  // Column 2: Wikipedia-only beats (pure, no DB writes)
  let wikiBeats: StoryBeat[] = []
  let wikiError: string | null = null
  try {
    if (releaseYear) {
      const plot = await fetchWikipediaPlot(film.title, releaseYear)
      if (plot) {
        wikiBeats = await generateBeatsFromPlot(film.title, releaseYear, runtime, plot)
      }
    } else {
      wikiError = 'no release year'
    }
  } catch (err) {
    wikiError = err instanceof Error ? err.message : String(err)
  }

  // Column 3: Hybrid beats
  let hybrid: HybridResult | null = null
  let hybridError: string | null = null
  try {
    hybrid = await generateHybridSentimentGraph(filmId)
  } catch (err) {
    hybridError = err instanceof Error ? err.message : String(err)
  }

  // Header row
  write(
    `${padRight(`CURRENT — DB (${currentBeats.length})`, COL_WIDTH)}│ ${padRight(`WIKIPEDIA-ONLY (${wikiBeats.length})`, COL_WIDTH)}│ ${padRight(`HYBRID (${hybrid?.beats.length ?? 0})`, COL_WIDTH)}`
  )
  write('─'.repeat(COL_WIDTH) + '┼' + '─'.repeat(COL_WIDTH + 1) + '┼' + '─'.repeat(COL_WIDTH + 1))

  const maxRows = Math.max(currentBeats.length, wikiBeats.length, hybrid?.beats.length ?? 0)
  for (let i = 0; i < maxRows; i++) {
    const c = currentBeats[i]
    const w = wikiBeats[i]
    const h = hybrid?.beats[i]
    const cStr = c ? formatBeatRow({ label: c.label, timeStart: c.timeStart, timeEnd: c.timeEnd, score: c.score }) : ''
    const wStr = w ? formatBeatRow({ label: w.label, timeStart: w.timeStart, timeEnd: w.timeEnd }) : ''
    const hStr = h ? formatBeatRow({ label: h.label, timeStart: h.timeStart, timeEnd: h.timeEnd, score: h.score }) : ''
    write(`${padRight(cStr, COL_WIDTH)}│ ${padRight(wStr, COL_WIDTH)}│ ${padRight(hStr, COL_WIDTH)}`)
  }

  write('')
  if (wikiError) write(`Wiki-only error: ${wikiError}`)
  if (hybridError) {
    write(`HYBRID ERROR: ${hybridError}`)
  } else if (hybrid) {
    write(`MODE                   : ${hybrid.generationMode}`)
    write(`Wikipedia plot found   : ${hybrid.wikipediaPlotAvailable ? 'yes' : 'no'}`)
    write(`Wikipedia plot length  : ${hybrid.wikipediaPlotLength} chars`)
    write(`Quality reviews used   : ${hybrid.reviewCount}`)
    write(`Token usage (input)    : ${hybrid.tokenUsage.input}`)
    write(`Token usage (output)   : ${hybrid.tokenUsage.output}`)
    write(`Duration               : ${hybrid.durationMs} ms`)
    write(`Overall sentiment      : ${hybrid.overallScore.toFixed(2)}`)
    write(`Peak                   : ${hybrid.peakMoment.label} (${hybrid.peakMoment.score}) @ ${hybrid.peakMoment.time} min`)
    write(`Lowest                 : ${hybrid.lowestMoment.label} (${hybrid.lowestMoment.score}) @ ${hybrid.lowestMoment.time} min`)
    write(`Biggest swing          : ${hybrid.biggestSentimentSwing}`)
    write(`Summary                : ${hybrid.summary}`)

    write('')
    write('─── PROMPT SENT TO CLAUDE ───')
    if (hybrid.prompt.system) {
      write('--- SYSTEM ---')
      write(hybrid.prompt.system)
      write('')
    }
    write('--- USER ---')
    write(truncatePlotSection(hybrid.prompt.user))
    write('─── END PROMPT ───')
  }
  write('')
}

async function main() {
  const rawArgs = process.argv.slice(2)
  const allowPrerelease = rawArgs.includes('--allow-prerelease')
  const filmIds = rawArgs.filter((a) => !a.startsWith('--'))
  if (filmIds.length === 0) {
    console.error('Usage: npx tsx scripts/test-hybrid.ts <filmId1> <filmId2> ... [--allow-prerelease]')
    process.exit(1)
  }

  // Dynamic imports: load AFTER dotenv has populated env, so prisma.ts and
  // hybrid-sentiment.ts see DATABASE_URL / ANTHROPIC_API_KEY when their
  // module bodies evaluate.
  const { prisma } = await import('../src/lib/prisma')
  const { isQualityReview } = await import('../src/lib/sentiment-pipeline')
  const { fetchWikipediaPlot } = await import('../src/lib/sources/wikipedia')
  const { generateBeatsFromPlot } = await import('../src/lib/beat-generator')
  const { generateHybridSentimentGraph } = await import('../src/lib/hybrid-sentiment')

  // Test-only bypass for the pre-release releaseDate guard inside
  // generateHybridSentimentGraph. We do NOT modify hybrid-sentiment.ts;
  // instead we monkey-patch prisma.film.findUnique for this script only so
  // that a future releaseDate is transparently rewritten to just before now.
  // This is scoped to the test harness — no other code path sees the patch.
  if (allowPrerelease) {
    type FindUnique = typeof prisma.film.findUnique
    const originalFindUnique = prisma.film.findUnique.bind(prisma.film) as unknown as (
      args: Parameters<FindUnique>[0]
    ) => Promise<unknown>
    prisma.film.findUnique = (async (args: Parameters<FindUnique>[0]) => {
      const film = await originalFindUnique(args)
      if (
        film &&
        typeof film === 'object' &&
        'releaseDate' in film &&
        film.releaseDate instanceof Date &&
        film.releaseDate > new Date()
      ) {
        return { ...film, releaseDate: new Date(Date.now() - 1000) }
      }
      return film
    }) as unknown as FindUnique
  }

  const deps: Deps = {
    prisma,
    isQualityReview,
    fetchWikipediaPlot,
    generateBeatsFromPlot,
    generateHybridSentimentGraph,
  }

  write(`test-hybrid run at ${new Date().toISOString()}`)
  write(`filmIds: ${filmIds.join(', ')}`)
  if (allowPrerelease) write(`NOTE: --allow-prerelease active (pre-release guard bypassed via in-memory releaseDate rewrite)`)
  write('')

  for (const filmId of filmIds) {
    try {
      await runOne(filmId, deps)
    } catch (err) {
      write(`Fatal error on ${filmId}: ${err instanceof Error ? err.message : String(err)}`)
      write('')
    }
  }

  write('='.repeat(60))
  write('Run complete. See per-film token usage above.')
  write(`Output written to: ${outputPath}`)

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('test-hybrid failed:', err)
  process.exit(1)
})
