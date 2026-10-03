/**
 * Reword stored graph text that shares 8+ consecutive words with a source
 * review, without regenerating any graph.
 *
 * For each SentimentGraph, the same check the generator enforces
 * (findVerbatimViolations) is re-run against the film's stored reviews. Only
 * the failing passages are sent to the model, through the same rewording
 * request the app uses (requestRewordings: schema-constrained JSON, passages
 * and the phrase to avoid only, no reviews). Each rewrite is re-checked with
 * the same 8-word rule and written only if it passes.
 *
 * What is written: the reworded text and nothing else.
 *   - dataPoints[i].reviewEvidence for flagged beats (and the same beat in
 *     criticDataPoints when it carries the same text)
 *   - summary and biggestSwing when they were flagged
 * Scores, labels, labelFull, timestamps, confidence, overallScore,
 * previousScore, version, and generatedAt are not touched. Before each write
 * the script verifies, field by field, that nothing but reviewEvidence
 * differs, and aborts that film if anything does.
 *
 * Writes are optimistic (WHERE id AND version), so a graph regenerated while
 * the script runs is skipped rather than overwritten. The film's cache is
 * invalidated after a write.
 *
 * Passages that still fail after one rewording are left as they are and
 * listed at the end and in reword-copied-passages-run.jsonl.
 *
 * Run this BEFORE scripts/cleanup/delete-removed-source-reviews.ts: once a
 * review is deleted, a passage copying it can no longer be detected.
 *
 * Usage:
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/reword-copied-passages.ts --dry-run --expect-host plain-shadow
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/reword-copied-passages.ts --commit  --expect-host plain-shadow
 *   ... --limit 20          first 20 failing films only
 *   ... --film-ids a,b,c    restrict to these films
 *   ... --concurrency 4     parallel rewording requests (default 4)
 *
 * --dry-run makes no model calls and no writes; it counts the failing
 * passages and films and estimates the cost. --expect-host is required.
 */
import './_load-env'
import './_neon-ws'

import fs from 'node:fs'
import path from 'node:path'
import type { Prisma } from '../src/generated/prisma/client'
import { prisma } from '../src/lib/prisma'
import { buildRewritePrompt, requestRewordings } from '../src/lib/claude'
import {
  buildReviewRunIndex,
  findVerbatimRun,
  findVerbatimViolations,
  type VerbatimViolation,
} from '../src/lib/sentiment-guards'
import { invalidateFilmCache } from '../src/lib/cache'

const RUN_LOG = path.resolve('reword-copied-passages-run.jsonl')
const FILM_PAGE = 100
// claude-sonnet-4-6 standard pricing, USD per million tokens.
const PRICE_INPUT = 3
const PRICE_OUTPUT = 15

interface Args {
  dryRun: boolean
  commit: boolean
  expectHost: string
  limit: number | null
  filmIds: Set<string> | null
  concurrency: number
}

function parseArgs(argv: string[]): Args {
  let dryRun = false
  let commit = false
  let expectHost: string | null = null
  let limit: number | null = null
  let filmIds: Set<string> | null = null
  let concurrency = 4
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--commit') commit = true
    else if (a === '--expect-host') expectHost = argv[++i] ?? null
    else if (a === '--limit') limit = Number(argv[++i])
    else if (a === '--concurrency') concurrency = Number(argv[++i])
    else if (a === '--film-ids') {
      const raw = argv[++i]
      if (!raw) throw new Error('--film-ids requires a comma-separated list')
      filmIds = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
    } else throw new Error(`Unknown argument: ${a}`)
  }
  if (!dryRun && !commit) throw new Error('Must pass --dry-run or --commit')
  if (dryRun && commit) throw new Error('Cannot pass both --dry-run and --commit')
  if (!expectHost) throw new Error('--expect-host <substring> is required (production is plain-shadow)')
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer')
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('--concurrency must be 1..16')
  return { dryRun, commit, expectHost, limit, filmIds, concurrency }
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

type Beat = Record<string, unknown>

interface Target {
  graphId: string
  filmId: string
  title: string
  version: number
  dataPoints: Beat[]
  criticDataPoints: Beat[] | null
  summary: string | null
  biggestSwing: string | null
  reviewTexts: string[]
  violations: VerbatimViolation[]
}

function logRun(event: Record<string, unknown>): void {
  fs.appendFileSync(RUN_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`)
}

/** Everything about a beat except its reviewEvidence, as a comparable string. */
function beatSkeleton(beat: Beat): string {
  const { reviewEvidence: _ignored, ...rest } = beat
  void _ignored
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

async function loadTargets(args: Args): Promise<{ targets: Target[]; graphsScanned: number }> {
  const graphs = await prisma.sentimentGraph.findMany({
    where: args.filmIds ? { filmId: { in: [...args.filmIds] } } : undefined,
    select: {
      id: true,
      filmId: true,
      version: true,
      dataPoints: true,
      criticDataPoints: true,
      summary: true,
      biggestSwing: true,
      film: { select: { title: true } },
    },
    orderBy: { filmId: 'asc' },
  })

  const targets: Target[] = []
  for (let offset = 0; offset < graphs.length; offset += FILM_PAGE) {
    const page = graphs.slice(offset, offset + FILM_PAGE)
    const reviews = await prisma.review.findMany({
      where: { filmId: { in: page.map((g) => g.filmId) } },
      select: { filmId: true, reviewText: true },
    })
    const byFilm = new Map<string, string[]>()
    for (const r of reviews) {
      const list = byFilm.get(r.filmId) ?? []
      list.push(r.reviewText)
      byFilm.set(r.filmId, list)
    }
    for (const g of page) {
      const reviewTexts = byFilm.get(g.filmId) ?? []
      if (reviewTexts.length === 0) continue
      const dataPoints = Array.isArray(g.dataPoints) ? (g.dataPoints as unknown as Beat[]) : []
      const violations = findVerbatimViolations(
        { dataPoints, summary: g.summary, biggestSentimentSwing: g.biggestSwing },
        reviewTexts,
        { filmTitle: g.film.title }
      )
      if (violations.length === 0) continue
      targets.push({
        graphId: g.id,
        filmId: g.filmId,
        title: g.film.title,
        version: g.version,
        dataPoints,
        criticDataPoints: Array.isArray(g.criticDataPoints) ? (g.criticDataPoints as unknown as Beat[]) : null,
        summary: g.summary,
        biggestSwing: g.biggestSwing,
        reviewTexts,
        violations,
      })
      if (args.limit && targets.length >= args.limit) return { targets, graphsScanned: graphs.length }
    }
  }
  return { targets, graphsScanned: graphs.length }
}

interface FilmOutcome {
  fixed: number
  stillFailing: Array<{ where: string; reason: string; text: string }>
  written: boolean
  skippedReason?: string
  inputTokens: number
  outputTokens: number
}

async function rewordFilm(t: Target): Promise<FilmOutcome> {
  const outcome: FilmOutcome = { fixed: 0, stillFailing: [], written: false, inputTokens: 0, outputTokens: 0 }
  const { rewrites, usage } = await requestRewordings(t.violations)
  outcome.inputTokens = usage.inputTokens
  outcome.outputTokens = usage.outputTokens

  const index = buildReviewRunIndex(t.reviewTexts)
  const dataPoints = t.dataPoints.map((b) => ({ ...b }))
  const criticDataPoints = t.criticDataPoints ? t.criticDataPoints.map((b) => ({ ...b })) : null
  let summary = t.summary
  let biggestSwing = t.biggestSwing

  t.violations.forEach((v, i) => {
    const text = rewrites.get(i + 1)
    if (!text) {
      outcome.stillFailing.push({ where: v.where, reason: 'the model returned no rewrite for this passage', text: v.text })
      return
    }
    const run = findVerbatimRun(text, index, { ignorePhrase: t.title })
    if (run) {
      outcome.stillFailing.push({ where: v.where, reason: `rewrite still shares "${run}"`, text: v.text })
      return
    }
    if (v.where === 'summary') summary = text
    else if (v.where === 'biggestSentimentSwing') biggestSwing = text
    else {
      const match = /^dataPoints\[(\d+)\]\.reviewEvidence/.exec(v.where)
      if (!match) {
        outcome.stillFailing.push({ where: v.where, reason: 'unrecognised location', text: v.text })
        return
      }
      const beatIndex = Number(match[1])
      const old = dataPoints[beatIndex].reviewEvidence
      dataPoints[beatIndex].reviewEvidence = text
      // The critic copy of the beat carries the same summary; keep them in step.
      if (criticDataPoints && criticDataPoints[beatIndex]?.reviewEvidence === old) {
        criticDataPoints[beatIndex].reviewEvidence = text
      }
    }
    outcome.fixed++
  })

  if (outcome.fixed === 0) return outcome

  // Nothing but reviewEvidence may differ. Checked, not assumed.
  assertOnlyEvidenceChanged(t.dataPoints, dataPoints, 'dataPoints')
  if (t.criticDataPoints && criticDataPoints) {
    assertOnlyEvidenceChanged(t.criticDataPoints, criticDataPoints, 'criticDataPoints')
  }

  const data: Prisma.SentimentGraphUpdateManyMutationInput = {
    dataPoints: dataPoints as unknown as Prisma.InputJsonValue,
  }
  if (criticDataPoints) data.criticDataPoints = criticDataPoints as unknown as Prisma.InputJsonValue
  if (summary !== t.summary) data.summary = summary
  if (biggestSwing !== t.biggestSwing) data.biggestSwing = biggestSwing

  const result = await prisma.sentimentGraph.updateMany({
    where: { id: t.graphId, version: t.version },
    data,
  })
  if (result.count === 0) {
    outcome.fixed = 0
    outcome.skippedReason = 'graph was regenerated while the script ran; left alone'
    return outcome
  }
  outcome.written = true
  await invalidateFilmCache(t.filmId).catch(() => {})
  return outcome
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        await worker(items[i], i)
      }
    })
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const host = databaseHost()
  console.log(`[db] host=${host}`)
  if (!host.includes(args.expectHost)) {
    console.error(`[db] host does not contain "${args.expectHost}"; aborting before any read or write`)
    process.exit(1)
  }
  if (args.commit && !(process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY)) {
    console.error('No Anthropic API key found (ANTHROPIC_API_KEY or CINEMA_ANTHROPIC_KEY)')
    process.exit(1)
  }
  console.log(`reword-copied-passages: ${args.dryRun ? 'DRY RUN (no model calls, no writes)' : 'COMMIT'}`)

  const { targets, graphsScanned } = await loadTargets(args)
  const passages = targets.reduce((n, t) => n + t.violations.length, 0)
  const beats = targets.reduce((n, t) => n + t.violations.filter((v) => v.where.startsWith('dataPoints')).length, 0)

  // Estimate from the actual prompts: input is the prompt, output is about
  // the length of the passages being rewritten plus JSON overhead.
  const promptChars = targets.reduce((n, t) => n + buildRewritePrompt(t.violations).length, 0)
  const passageChars = targets.reduce((n, t) => n + t.violations.reduce((m, v) => m + v.text.length + 30, 0), 0)
  const estInput = Math.round(promptChars / 4)
  const estOutput = Math.round(passageChars / 4)
  const estCost = (estInput / 1e6) * PRICE_INPUT + (estOutput / 1e6) * PRICE_OUTPUT

  console.log('\n=== PLAN ===')
  console.log(`  graphs scanned:          ${graphsScanned}`)
  console.log(`  films with a failure:    ${targets.length}${args.limit ? ` (limited to ${args.limit})` : ''}`)
  console.log(`  passages to reword:      ${passages}  (${beats} beats, ${passages - beats} summary or swing lines)`)
  console.log(`  model requests:          ${targets.length}  (one per film)`)
  console.log(`  estimated tokens:        ~${estInput} in, ~${estOutput} out`)
  console.log(`  estimated cost:          ~$${estCost.toFixed(2)} at standard pricing`)
  console.log(`  estimated time:          ~${Math.ceil((targets.length * 4) / args.concurrency / 60)} min at concurrency ${args.concurrency}`)

  if (args.dryRun) {
    console.log('\nFirst 10 failing passages:')
    for (const t of targets.slice(0, 10)) {
      const v = t.violations[0]
      console.log(`  "${t.title}" ${v.where}\n     shared run: "${v.run}"`)
    }
    console.log('\nDry run complete. No model calls, no writes.')
    await prisma.$disconnect()
    return
  }

  let filmsWritten = 0
  let passagesFixed = 0
  let requestFailures = 0
  let skipped = 0
  let inputTokens = 0
  let outputTokens = 0
  const stillFailing: Array<{ filmId: string; title: string; where: string; reason: string }> = []

  await runPool(targets, args.concurrency, async (t, i) => {
    try {
      const o = await rewordFilm(t)
      inputTokens += o.inputTokens
      outputTokens += o.outputTokens
      if (o.written) filmsWritten++
      passagesFixed += o.fixed
      if (o.skippedReason) {
        skipped++
        logRun({ event: 'skipped', filmId: t.filmId, title: t.title, reason: o.skippedReason })
      }
      for (const f of o.stillFailing) {
        stillFailing.push({ filmId: t.filmId, title: t.title, where: f.where, reason: f.reason })
        logRun({ event: 'still_failing', filmId: t.filmId, title: t.title, ...f })
      }
      if (o.written) logRun({ event: 'reworded', filmId: t.filmId, title: t.title, fixed: o.fixed })
    } catch (err) {
      requestFailures++
      const message = err instanceof Error ? err.message : String(err)
      for (const v of t.violations) stillFailing.push({ filmId: t.filmId, title: t.title, where: v.where, reason: `request failed: ${message}` })
      logRun({ event: 'request_failed', filmId: t.filmId, title: t.title, error: message })
      console.error(`  ✗ "${t.title}": ${message}`)
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${targets.length} films processed`)
  })

  const cost = (inputTokens / 1e6) * PRICE_INPUT + (outputTokens / 1e6) * PRICE_OUTPUT
  console.log('\n=== DONE ===')
  console.log(`  films written:           ${filmsWritten} of ${targets.length}`)
  console.log(`  passages reworded:       ${passagesFixed} of ${passages}`)
  console.log(`  passages still failing:  ${stillFailing.length}`)
  console.log(`  films skipped (changed): ${skipped}`)
  console.log(`  request failures:        ${requestFailures}`)
  console.log(`  tokens:                  ${inputTokens} in, ${outputTokens} out (~$${cost.toFixed(2)})`)
  console.log(`  run log:                 ${RUN_LOG}`)
  if (stillFailing.length > 0) {
    console.log('\nStill failing after one rewording (left unchanged):')
    for (const f of stillFailing.slice(0, 50)) console.log(`  "${f.title}" ${f.where}: ${f.reason}`)
    if (stillFailing.length > 50) console.log(`  ... and ${stillFailing.length - 50} more in the run log`)
    console.log('\nRe-running the same command retries only what still fails.')
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
