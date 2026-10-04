/**
 * Apply hand-written reviewEvidence to specific beats, for the few passages
 * the rewording script could not clear.
 *
 * Input is a JSON file of overrides:
 *   [{ "filmId", "title", "beatIndex", "label", "text" }]
 *
 * Same safety rules as scripts/reword-copied-passages.ts:
 *   - Each new text is checked with the app's 8-word rule against every
 *     stored review for the film (film title excluded). A text that shares a
 *     run is refused, not written.
 *   - The target is confirmed before writing: the film's title and the label
 *     of the beat at beatIndex must match the file, so a graph regenerated
 *     since the file was written is left alone.
 *   - Only reviewEvidence changes. Every beat is compared field by field
 *     before the write; scores, labels, and timestamps cannot differ.
 *   - The same beat in criticDataPoints is updated when it carries the same
 *     old text, so the blend base does not keep the old wording.
 *   - The write is conditional on the graph version that was read, and the
 *     film's cache is invalidated afterwards.
 *
 * --dry-run shows old and new text and the result of every check, and writes
 * nothing. --expect-host is required.
 *
 * Usage:
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/apply-evidence-overrides.ts --file scripts/data/evidence-overrides-2026-10-04.json --dry-run --expect-host plain-shadow
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/apply-evidence-overrides.ts --file scripts/data/evidence-overrides-2026-10-04.json --commit  --expect-host plain-shadow
 */
import './_load-env'
import './_neon-ws'

import fs from 'node:fs'
import type { Prisma } from '../src/generated/prisma/client'
import { prisma } from '../src/lib/prisma'
import { VERBATIM_RUN_WORDS, buildReviewRunIndex, findVerbatimRun } from '../src/lib/sentiment-guards'
import { invalidateFilmCache } from '../src/lib/cache'

interface Override {
  filmId: string
  title: string
  beatIndex: number
  label: string
  text: string
}

interface Args {
  dryRun: boolean
  commit: boolean
  expectHost: string
  file: string
}

function parseArgs(argv: string[]): Args {
  let dryRun = false
  let commit = false
  let expectHost: string | null = null
  let file: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--commit') commit = true
    else if (a === '--expect-host') expectHost = argv[++i] ?? null
    else if (a === '--file') file = argv[++i] ?? null
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!dryRun && !commit) throw new Error('Must pass --dry-run or --commit')
  if (dryRun && commit) throw new Error('Cannot pass both --dry-run and --commit')
  if (!expectHost) throw new Error('--expect-host <substring> is required (production is plain-shadow)')
  if (!file) throw new Error('--file <overrides.json> is required')
  return { dryRun, commit, expectHost, file }
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

function readOverrides(file: string): Override[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('overrides file must be a JSON array')
  return parsed.map((raw, i) => {
    const o = raw as Partial<Override>
    if (
      typeof o.filmId !== 'string' ||
      typeof o.title !== 'string' ||
      typeof o.label !== 'string' ||
      typeof o.text !== 'string' ||
      !Number.isInteger(o.beatIndex) ||
      o.text.trim() === ''
    ) {
      throw new Error(`override ${i} is missing filmId, title, beatIndex, label, or text`)
    }
    return { filmId: o.filmId, title: o.title, beatIndex: o.beatIndex as number, label: o.label, text: o.text.trim() }
  })
}

type Beat = Record<string, unknown>

/** Everything about a beat except its reviewEvidence, as a comparable string. */
function beatSkeleton(beat: Beat): string {
  const rest = { ...beat }
  delete rest.reviewEvidence
  return JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]))
}

function assertOnlyEvidenceChanged(before: Beat[], after: Beat[], what: string): void {
  if (before.length !== after.length) throw new Error(`${what}: beat count changed`)
  for (let i = 0; i < before.length; i++) {
    if (beatSkeleton(before[i]) !== beatSkeleton(after[i])) {
      throw new Error(`${what}[${i}]: a field other than reviewEvidence changed`)
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const host = databaseHost()
  console.log(`[db] host=${host}`)
  if (!host.includes(args.expectHost)) {
    console.error(`[db] host does not contain "${args.expectHost}"; aborting before any read or write`)
    process.exit(1)
  }
  const overrides = readOverrides(args.file)
  console.log(`apply-evidence-overrides: ${args.dryRun ? 'DRY RUN (no writes)' : 'COMMIT'}, ${overrides.length} override(s) from ${args.file}`)

  let applied = 0
  let refused = 0

  for (const o of overrides) {
    console.log(`\n"${o.title}" beat ${o.beatIndex} ("${o.label}")`)
    const refuse = (reason: string) => {
      refused++
      console.log(`  REFUSED: ${reason}`)
    }

    const graph = await prisma.sentimentGraph.findUnique({
      where: { filmId: o.filmId },
      select: {
        id: true,
        version: true,
        dataPoints: true,
        criticDataPoints: true,
        film: { select: { title: true } },
      },
    })
    if (!graph) {
      refuse('no sentiment graph for this film')
      continue
    }
    if (graph.film.title !== o.title) {
      refuse(`film title is "${graph.film.title}", not "${o.title}"`)
      continue
    }
    const dataPoints = Array.isArray(graph.dataPoints) ? (graph.dataPoints as unknown as Beat[]) : []
    const beat = dataPoints[o.beatIndex]
    if (!beat) {
      refuse(`graph has ${dataPoints.length} beats; no beat at index ${o.beatIndex}`)
      continue
    }
    if (beat.label !== o.label) {
      refuse(`beat ${o.beatIndex} is labelled "${String(beat.label)}"; the graph has changed since the override was written`)
      continue
    }

    const reviews = await prisma.review.findMany({ where: { filmId: o.filmId }, select: { reviewText: true } })
    const index = buildReviewRunIndex(reviews.map((r) => r.reviewText))
    const run = findVerbatimRun(o.text, index, { ignorePhrase: o.title })
    console.log(`  old: ${String(beat.reviewEvidence ?? '')}`)
    console.log(`  new: ${o.text}`)
    console.log(`  checked against ${reviews.length} stored review(s) with the ${VERBATIM_RUN_WORDS}-word rule: ${run ? 'FAILS' : 'passes'}`)
    if (run) {
      refuse(`new text shares "${run}" with a stored review`)
      continue
    }
    if (beat.reviewEvidence === o.text) {
      console.log('  already applied; nothing to do')
      continue
    }

    const old = beat.reviewEvidence
    const nextDataPoints = dataPoints.map((b, i) => (i === o.beatIndex ? { ...b, reviewEvidence: o.text } : { ...b }))
    const critic = Array.isArray(graph.criticDataPoints) ? (graph.criticDataPoints as unknown as Beat[]) : null
    const nextCritic =
      critic && critic[o.beatIndex]?.label === o.label && critic[o.beatIndex]?.reviewEvidence === old
        ? critic.map((b, i) => (i === o.beatIndex ? { ...b, reviewEvidence: o.text } : { ...b }))
        : null

    assertOnlyEvidenceChanged(dataPoints, nextDataPoints, 'dataPoints')
    if (critic && nextCritic) assertOnlyEvidenceChanged(critic, nextCritic, 'criticDataPoints')
    console.log(`  fields other than reviewEvidence unchanged: verified${nextCritic ? ' (dataPoints and criticDataPoints)' : ''}`)

    if (args.dryRun) {
      console.log('  would write')
      continue
    }

    const data: Prisma.SentimentGraphUpdateManyMutationInput = {
      dataPoints: nextDataPoints as unknown as Prisma.InputJsonValue,
    }
    if (nextCritic) data.criticDataPoints = nextCritic as unknown as Prisma.InputJsonValue
    const result = await prisma.sentimentGraph.updateMany({ where: { id: graph.id, version: graph.version }, data })
    if (result.count === 0) {
      refuse('graph was regenerated while the script ran; left alone')
      continue
    }
    await invalidateFilmCache(o.filmId).catch(() => {})
    applied++
    console.log('  written, cache invalidated')
  }

  console.log(`\n=== ${args.dryRun ? 'DRY RUN' : 'DONE'} ===  ${args.dryRun ? 'would apply' : 'applied'}: ${args.dryRun ? overrides.length - refused : applied}, refused: ${refused}`)
  await prisma.$disconnect()
  if (refused > 0) process.exit(2)
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
