/**
 * Read-only scan: does any stored, displayed graph text share a run of
 * VERBATIM_RUN_WORDS (8) consecutive words with one of its film's stored
 * source reviews?
 *
 * Uses the SAME check the generator now enforces (findVerbatimRun in
 * src/lib/sentiment-guards.ts): case-insensitive, punctuation ignored, the
 * film's own title excluded. Scans each beat's reviewEvidence plus the graph
 * summary and biggest-swing line, since all three reach a screen.
 *
 * No model calls. No writes. --expect-host is required.
 *
 * Usage:
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/scan-verbatim-evidence.ts --expect-host plain-shadow
 *   ... --examples 40        how many failing texts to print (default 20)
 *   ... --out failures.jsonl  write every failure as one JSON line
 *   ... --run-words 10       try a different threshold without changing the app
 */
import './_load-env'
import './_neon-ws'

import fs from 'node:fs'
import { prisma } from '../src/lib/prisma'
import {
  VERBATIM_RUN_WORDS,
  buildReviewRunIndex,
  displayedGraphTexts,
  findVerbatimRun,
} from '../src/lib/sentiment-guards'

const FILM_PAGE = 100

interface Args {
  expectHost: string
  examples: number
  out: string | null
  runWords: number
}

function parseArgs(argv: string[]): Args {
  let expectHost: string | null = null
  let examples = 20
  let out: string | null = null
  let runWords = VERBATIM_RUN_WORDS
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--expect-host') expectHost = argv[++i] ?? null
    else if (a === '--examples') examples = Number(argv[++i])
    else if (a === '--out') out = argv[++i] ?? null
    else if (a === '--run-words') runWords = Number(argv[++i])
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!expectHost) throw new Error('--expect-host <substring> is required (production is plain-shadow)')
  if (!Number.isInteger(examples) || examples < 0) throw new Error('--examples must be a non-negative integer')
  if (!Number.isInteger(runWords) || runWords < 3) throw new Error('--run-words must be an integer of at least 3')
  return { expectHost, examples, out, runWords }
}

function databaseHost(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  try {
    return new URL(url).host
  } catch {
    return '<unparseable DATABASE_URL>'
  }
}

interface Failure {
  filmId: string
  title: string
  where: string
  run: string
  text: string
  source: string | null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const host = databaseHost()
  console.log(`[db] host=${host}`)
  if (!host.includes(args.expectHost)) {
    console.error(`[db] host does not contain "${args.expectHost}"; aborting before any read`)
    process.exit(1)
  }
  console.log(`scan-verbatim-evidence: read-only, run length ${args.runWords} words`)

  const graphs = await prisma.sentimentGraph.findMany({
    select: {
      filmId: true,
      dataPoints: true,
      summary: true,
      biggestSwing: true,
      film: { select: { title: true } },
    },
    orderBy: { filmId: 'asc' },
  })
  console.log(`Loaded ${graphs.length} sentiment graphs`)

  const failures: Failure[] = []
  let beatsScanned = 0
  let beatsFailed = 0
  let filmsWithNoReviews = 0
  const failingFilms = new Set<string>()

  for (let offset = 0; offset < graphs.length; offset += FILM_PAGE) {
    const page = graphs.slice(offset, offset + FILM_PAGE)
    const reviews = await prisma.review.findMany({
      where: { filmId: { in: page.map((g) => g.filmId) } },
      select: { filmId: true, reviewText: true, sourcePlatform: true },
    })
    const byFilm = new Map<string, { reviewText: string; sourcePlatform: string }[]>()
    for (const r of reviews) {
      const list = byFilm.get(r.filmId) ?? []
      list.push({ reviewText: r.reviewText, sourcePlatform: r.sourcePlatform })
      byFilm.set(r.filmId, list)
    }

    for (const g of page) {
      const filmReviews = byFilm.get(g.filmId) ?? []
      const beats = Array.isArray(g.dataPoints)
        ? (g.dataPoints as unknown as Array<{ label?: unknown; reviewEvidence?: unknown }>)
        : []
      const texts = displayedGraphTexts({
        dataPoints: beats,
        summary: g.summary,
        biggestSentimentSwing: g.biggestSwing,
      })
      beatsScanned += texts.filter((t) => t.where.startsWith('dataPoints')).length
      if (filmReviews.length === 0) {
        filmsWithNoReviews++
        continue
      }
      const index = buildReviewRunIndex(
        filmReviews.map((r) => r.reviewText),
        args.runWords
      )
      for (const { where, text } of texts) {
        const run = findVerbatimRun(text, index, { n: args.runWords, ignorePhrase: g.film.title })
        if (!run) continue
        if (where.startsWith('dataPoints')) beatsFailed++
        failingFilms.add(g.filmId)
        // Which source the run came from, for the report only.
        const source =
          filmReviews.find((r) => buildReviewRunIndex([r.reviewText], args.runWords).has(run))?.sourcePlatform ?? null
        failures.push({ filmId: g.filmId, title: g.film.title, where, run, text, source })
      }
    }
    if ((offset + FILM_PAGE) % 500 === 0) console.log(`  scanned ${Math.min(offset + FILM_PAGE, graphs.length)} of ${graphs.length}`)
  }

  const bySource: Record<string, number> = {}
  for (const f of failures) bySource[f.source ?? 'unknown'] = (bySource[f.source ?? 'unknown'] ?? 0) + 1
  const otherFields = failures.filter((f) => !f.where.startsWith('dataPoints')).length

  console.log('\n=== RESULT ===')
  console.log(`  graphs scanned:               ${graphs.length}`)
  console.log(`  graphs with no stored reviews: ${filmsWithNoReviews}  (cannot be checked)`)
  console.log(`  beats scanned:                ${beatsScanned}`)
  console.log(`  beats failing:                ${beatsFailed}  (${beatsScanned ? ((beatsFailed / beatsScanned) * 100).toFixed(2) : '0'}%)`)
  console.log(`  summary / swing lines failing: ${otherFields}`)
  console.log(`  films with any failure:       ${failingFilms.size}  (${graphs.length ? ((failingFilms.size / graphs.length) * 100).toFixed(2) : '0'}%)`)
  console.log(`  failures by source platform:  ${JSON.stringify(bySource)}`)

  if (args.examples > 0 && failures.length > 0) {
    console.log(`\n=== ${Math.min(args.examples, failures.length)} EXAMPLES ===`)
    for (const f of failures.slice(0, args.examples)) {
      console.log(`  "${f.title}" ${f.where} [${f.source ?? '?'}]`)
      console.log(`     shared run: "${f.run}"`)
      console.log(`     text:       ${f.text.slice(0, 220)}`)
    }
  }
  if (args.out) {
    fs.writeFileSync(args.out, failures.map((f) => JSON.stringify(f)).join('\n') + (failures.length ? '\n' : ''))
    console.log(`\nWrote ${failures.length} failures to ${args.out}`)
  }

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('Fatal:', err)
  try {
    await prisma.$disconnect()
  } catch {
    // ignore
  }
  process.exit(1)
})
