/**
 * Restore clean critic beats on films that were blended before
 * SentimentGraph.criticDataPoints existed, without losing user ratings.
 *
 * Those rows hold compounded beats: the blender re-blended its own output
 * toward the user averages on every review. The original critic scores are
 * gone, and a normal regeneration would merge (the films have user beat
 * ratings) or, with new labels, orphan those ratings.
 *
 * So this script keeps the beat SKELETON (labels, labelFull, timestamps)
 * exactly as stored, which is what user beat ratings are keyed by, and asks
 * the model to re-score each existing beat from the reviews. The result is
 * written as the critic beats (criticDataPoints) through the beat-lock merge
 * (labels match, so only scores move), then the blender is run so dataPoints
 * becomes a fresh blend from the clean base.
 *
 * Selection: varianceSource = 'blended' AND criticDataPoints IS NULL. After
 * #122's migration those are exactly the legacy blended rows.
 *
 * Synchronous Claude calls (the set is small; a few films, not thousands).
 * Roughly $0.05 per film at standard pricing.
 *
 * Usage:
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/restore-critic-beats.ts --dry-run --expect-host plain-shadow
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/restore-critic-beats.ts --commit  --expect-host plain-shadow
 *   ... --film-ids a,b,c      restrict to these films
 *
 * --dry-run lists the films (title, beats, rated reviews, last generated)
 * and makes no model calls and no writes. --expect-host is required.
 */
import './_load-env'
import './_neon-ws'

import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../src/lib/prisma'
import { SENTIMENT_MODEL, SENTIMENT_MAX_TOKENS, ensureNoVerbatimReviewText } from '../src/lib/claude'
import { requireFilmRuntime, overallScoreFromBeats } from '../src/lib/sentiment-guards'
import { isQualityReview } from '../src/lib/sentiment-pipeline'
import { fetchWikipediaPlot } from '../src/lib/sources/wikipedia'
import { safeWriteSentimentGraph } from '../src/lib/sentiment-beat-lock'
import { maybeBlendAndUpdate } from '../src/lib/review-blender'
import { invalidateFilmCache } from '../src/lib/cache'
import type { SentimentDataPoint } from '../src/lib/types'
import type { Review } from '../src/generated/prisma/client'

const REVIEW_CAP = 30
const REVIEW_CHAR_CAP = 1500
const PLOT_CHAR_CAP = 6000

interface Args {
  dryRun: boolean
  commit: boolean
  expectHost: string
  filmIds: Set<string> | null
}

function parseArgs(argv: string[]): Args {
  let dryRun = false
  let commit = false
  let expectHost: string | null = null
  let filmIds: Set<string> | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--commit') commit = true
    else if (a === '--expect-host') {
      expectHost = argv[++i] ?? null
      if (!expectHost) throw new Error('--expect-host requires a substring')
    } else if (a === '--film-ids') {
      const raw = argv[++i]
      if (!raw) throw new Error('--film-ids requires a comma-separated list')
      filmIds = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
    } else throw new Error(`Unknown argument: ${a}`)
  }
  if (!dryRun && !commit) throw new Error('Must pass --dry-run or --commit')
  if (dryRun && commit) throw new Error('Cannot pass both --dry-run and --commit')
  if (!expectHost) throw new Error('--expect-host <substring> is required (production is plain-shadow)')
  return { dryRun, commit, expectHost, filmIds }
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

// ── Rescoring prompt ─────────────────────────────────────────────────────────

function buildReviewBlock(reviews: Review[]): string {
  return reviews
    .slice(0, REVIEW_CAP)
    .map(
      (r, i) =>
        `[Review ${i + 1}, ${r.sourcePlatform}${r.sourceRating ? ` (${r.sourceRating}/10)` : ''}${r.author ? ` by ${r.author}` : ''}]\n${r.reviewText.slice(0, REVIEW_CHAR_CAP)}`
    )
    .join('\n\n---\n\n')
}

function buildRescorePrompt(params: {
  title: string
  year: number | 'Unknown'
  runtime: number
  beats: SentimentDataPoint[]
  plotText: string | null
  reviews: Review[]
}): string {
  const { title, year, runtime, beats, plotText, reviews } = params
  const beatList = beats
    .map(
      (b, i) =>
        `${i + 1}. label: "${b.label}"${b.labelFull ? ` | labelFull: "${b.labelFull}"` : ''} | minutes ${b.timeStart} to ${b.timeEnd}`
    )
    .join('\n')
  const plotSection = plotText
    ? `\n## Plot Summary (for orientation only)\n\n${plotText.slice(0, PLOT_CHAR_CAP)}\n`
    : ''

  return `You are a film sentiment analyst. The story beats of "${title}" (${year}, ${runtime} minutes) are FIXED and listed below. Do not add, remove, rename, reorder, or re-time any beat. Your only job is to score each beat from the reviews.

## Beats (fixed)
${beatList}
${plotSection}
## Scoring

Use the full 1.0 to 10.0 scale. Score each beat on what REVIEWERS said about that stretch of the film, not on the emotional tone of the events: a devastating scene that critics call masterful scores high, a stretch they found slow or shallow scores low. Not every film is a flat 7 to 8. Do not steer the scores toward any external rating; the film's overall score is computed afterwards as the plain average of your beat scores.

Confidence: "high" when several reviews discuss that part, "medium" when some do, "low" when it is inferred from general sentiment.

reviewEvidence: a 1 to 2 sentence synthesis of what reviewers said about that stretch, written entirely in your own words. Never quote a review and never reuse a reviewer's phrasing; a response that copies review wording is rejected.

## Reviews

${buildReviewBlock(reviews)}

## Output

Return EXACTLY ONE JSON object, no prose, no markdown fences:

{
  "beats": [
    { "label": "<exact label from the list, unchanged>", "score": <number 1.0 to 10.0>, "confidence": "low" | "medium" | "high", "reviewEvidence": "<1 to 2 sentences>" }
  ]
}

The array must contain every listed beat exactly once, in the listed order, with the label copied exactly.`
}

interface RescoredBeat {
  label: string
  score: number
  confidence: 'low' | 'medium' | 'high'
  reviewEvidence: string
}

function parseRescore(text: string, beats: SentimentDataPoint[]): RescoredBeat[] {
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
  const parsed = JSON.parse(cleaned) as { beats?: unknown }
  if (!Array.isArray(parsed.beats)) throw new Error('Response has no beats array')
  if (parsed.beats.length !== beats.length) {
    throw new Error(`Expected ${beats.length} beats, got ${parsed.beats.length}`)
  }
  const out: RescoredBeat[] = []
  for (let i = 0; i < beats.length; i++) {
    const b = parsed.beats[i] as Record<string, unknown>
    if (!b || typeof b !== 'object') throw new Error(`beats[${i}] is not an object`)
    if (b.label !== beats[i].label) {
      throw new Error(`beats[${i}] label mismatch: expected "${beats[i].label}", got "${String(b.label)}"`)
    }
    const score = b.score
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 1 || score > 10) {
      throw new Error(`beats[${i}] score out of range: ${String(score)}`)
    }
    const confidence = b.confidence === 'high' || b.confidence === 'low' ? b.confidence : 'medium'
    const reviewEvidence = typeof b.reviewEvidence === 'string' ? b.reviewEvidence : ''
    out.push({ label: beats[i].label, score, confidence, reviewEvidence })
  }
  return out
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const host = databaseHost()
  console.log(`[db] host=${host}`)
  if (!host.includes(args.expectHost)) {
    console.error(`[db] host does not contain "${args.expectHost}"; aborting before any read or write`)
    process.exit(1)
  }
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY
  if (args.commit && !apiKey) {
    console.error('No Anthropic API key found (ANTHROPIC_API_KEY or CINEMA_ANTHROPIC_KEY)')
    process.exit(1)
  }
  console.log(`restore-critic-beats: ${args.dryRun ? 'DRY RUN (no model calls, no writes)' : 'COMMIT'}`)

  // Legacy blended rows: blended before criticDataPoints existed.
  const rows = await prisma.$queryRaw<
    Array<{ filmId: string; title: string; beatCount: number; version: number; generatedAt: Date; ratedReviews: number }>
  >`
    SELECT sg."filmId",
           f.title,
           jsonb_array_length(sg."dataPoints")::int AS "beatCount",
           sg.version,
           sg."generatedAt",
           (SELECT count(*)::int FROM "UserReview" ur
             WHERE ur."filmId" = sg."filmId" AND ur.status = 'approved'
               AND ur."beatRatings" IS NOT NULL
               AND jsonb_typeof(ur."beatRatings") = 'object'
               AND ur."beatRatings" <> '{}'::jsonb) AS "ratedReviews"
    FROM "SentimentGraph" sg
    JOIN "Film" f ON f.id = sg."filmId"
    WHERE sg."varianceSource" = 'blended'
      AND sg."criticDataPoints" IS NULL
    ORDER BY f.title
  `
  const targets = args.filmIds ? rows.filter((r) => args.filmIds!.has(r.filmId)) : rows

  console.log(`\nLegacy blended films without clean critic beats: ${rows.length}${args.filmIds ? ` (targeting ${targets.length})` : ''}`)
  for (const r of targets) {
    console.log(
      `  ${r.filmId}  "${r.title}"  beats=${r.beatCount}  ratedReviews=${r.ratedReviews}  v${r.version}  generated ${r.generatedAt.toISOString().slice(0, 10)}`
    )
  }

  if (args.dryRun) {
    console.log(`\nDry run complete. Would re-score ${targets.length} films (about $0.05 each, standard pricing).`)
    await prisma.$disconnect()
    return
  }

  const anthropic = new Anthropic({ apiKey })
  let restored = 0
  let failed = 0

  for (const r of targets) {
    try {
      const film = await prisma.film.findUnique({ where: { id: r.filmId } })
      if (!film) throw new Error('film vanished')
      const graph = await prisma.sentimentGraph.findUnique({ where: { filmId: r.filmId } })
      if (!graph) throw new Error('graph vanished')
      const beats = graph.dataPoints as unknown as SentimentDataPoint[]
      if (!Array.isArray(beats) || beats.length === 0) throw new Error('no beats')

      const runtime = requireFilmRuntime(film)
      const storedReviews = await prisma.review.findMany({ where: { filmId: film.id }, orderBy: { fetchedAt: 'desc' } })
      const reviews = storedReviews.filter((rv) => isQualityReview(rv.reviewText))
      if (reviews.length < 3) throw new Error(`only ${reviews.length} quality reviews`)
      const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : 'Unknown'
      const plotText = typeof year === 'number' ? await fetchWikipediaPlot(film.title, year) : null

      const prompt = buildRescorePrompt({ title: film.title, year, runtime, beats, plotText, reviews })
      const message = await anthropic.messages.create({
        model: SENTIMENT_MODEL,
        max_tokens: SENTIMENT_MAX_TOKENS,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      })
      const text = message.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
      // Same guard as the app: no run of a reviewer's words in displayed
      // text. One rewording request if there is; rejected if that fails.
      const rescored = (
        await ensureNoVerbatimReviewText(
          { dataPoints: parseRescore(text, beats) },
          storedReviews.map((rv) => rv.reviewText),
          { filmTitle: film.title, filmId: film.id }
        )
      ).dataPoints

      // Same skeleton, fresh critic scores.
      const criticBeats: SentimentDataPoint[] = beats.map((b, i) => ({
        ...b,
        score: rescored[i].score,
        confidence: rescored[i].confidence,
        reviewEvidence: rescored[i].reviewEvidence,
      }))

      // 1. Write the clean critic beats. The film has user ratings, so this
      //    takes the merge path: labels match, only scores move, and the
      //    write path records them as criticDataPoints (non-blender caller).
      await safeWriteSentimentGraph({
        filmId: film.id,
        incomingDataPoints: criticBeats,
        otherFields: {
          previousScore: graph.overallScore,
          overallScore: overallScoreFromBeats(criticBeats),
          varianceSource: 'external_only',
          generatedAt: new Date(),
          version: graph.version + 1,
        },
        callerPath: 'script-restore-critic-beats',
      })

      // 2. Re-blend from the clean base so dataPoints carries a fresh blend.
      await maybeBlendAndUpdate(film.id)
      await invalidateFilmCache(film.id).catch(() => {})

      restored++
      console.log(
        `  ✓ "${film.title}"  critic mean ${overallScoreFromBeats(criticBeats)} (was ${graph.overallScore} blended)  tokens ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`
      )
    } catch (err) {
      failed++
      console.error(`  ✗ ${r.filmId} "${r.title}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`\n=== DONE ===  restored ${restored}, failed ${failed}`)
  await prisma.$disconnect()
  if (failed > 0) process.exit(2)
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
