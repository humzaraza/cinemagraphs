import Anthropic from '@anthropic-ai/sdk'
import { prisma } from './prisma'
import { fetchWikipediaPlot } from './sources/wikipedia'
import { isQualityReview } from './sentiment-pipeline'
import {
  SENTIMENT_MODEL,
  SENTIMENT_MAX_TOKENS,
  buildAnalysisPromptParts,
} from './claude'
import { pipelineLogger } from './logger'
import type { SentimentDataPoint, PeakLowMoment } from './types'
import type { Film, Review } from '@/generated/prisma/client'
import type { AnchorScores } from './omdb'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY || '',
})

const MIN_QUALITY_REVIEWS = 3
const HYBRID_PLOT_CHAR_CAP = 6000
const HYBRID_REVIEW_CAP = 30
const HYBRID_REVIEW_CHAR_CAP = 1500

export interface HybridResult {
  filmId: string
  filmTitle: string
  runtime: number
  reviewCount: number
  wikipediaPlotAvailable: boolean
  wikipediaPlotLength: number
  beats: SentimentDataPoint[]
  overallScore: number
  peakMoment: PeakLowMoment
  lowestMoment: PeakLowMoment
  biggestSentimentSwing: string
  summary: string
  generationMode: 'hybrid' | 'review_only_fallback'
  durationMs: number
  tokenUsage: { input: number; output: number }
  prompt: { system: string | null; user: string }
}

function computeHybridBeatCount(runtime: number): number {
  const n = Math.round(runtime / 10)
  return Math.min(Math.max(n, 10), 20)
}

function buildAnchorString(film: Film): { anchorString: string; target: number } {
  const parts: string[] = []
  if (film.imdbRating) parts.push(`IMDb ${film.imdbRating}`)
  if (film.rtCriticsScore) parts.push(`RT ${film.rtCriticsScore}%`)
  if (film.metacriticScore) parts.push(`MC ${film.metacriticScore}`)
  return {
    anchorString: parts.join(' | ') || 'No anchor scores available',
    target: film.imdbRating || 7.0,
  }
}

function buildReviewBlock(reviews: Review[]): string {
  return reviews
    .slice(0, HYBRID_REVIEW_CAP)
    .map(
      (r, i) =>
        `[Review ${i + 1} — ${r.sourcePlatform}${r.sourceRating ? ` (${r.sourceRating}/10)` : ''}${r.author ? ` by ${r.author}` : ''}]\n${r.reviewText.slice(0, HYBRID_REVIEW_CHAR_CAP)}`
    )
    .join('\n\n---\n\n')
}

function buildHybridPrompt(params: {
  film: Film
  year: number | 'Unknown'
  runtime: number
  anchorString: string
  target: number
  plotText: string
  reviews: Review[]
  beatCount: number
}): string {
  const { film, year, runtime, anchorString, target, plotText, reviews, beatCount } = params
  const reviewBlock = buildReviewBlock(reviews)
  const sourcesArray = [...new Set(reviews.map((r) => r.sourcePlatform.toLowerCase()))]
  const beatDuration = Math.round(runtime / beatCount)

  return `You are a film sentiment analyst. Produce a sentiment graph for "${film.title}" (${year}) that fuses plot structure with audience reception.

The PLOT (from Wikipedia) is your ground truth for what happens in the film, which specific characters are involved, and the chronological order of events. The REVIEWS are your ground truth for how audiences felt at each part of the film — which moments landed, which fell flat, and how to score each beat.

## Film Information
- Title: ${film.title}
- Director: ${film.director || 'Unknown'}
- Year: ${year}
- Runtime: ${runtime} minutes
- Genres: ${film.genres?.join(', ') || 'Unknown'}

## Aggregate Scores (ANCHOR)
${anchorString}
Target overall sentiment: ${target} (your overall must land within ±0.2 of this)

## Plot Summary (ground truth for events, chronology, characters)

${plotText.slice(0, HYBRID_PLOT_CHAR_CAP)}

## Reviews (ground truth for emotional calibration and scoring)

${reviewBlock}

## Task

Produce EXACTLY ${beatCount} beats covering 0 to ${runtime} minutes. Each beat is roughly ${beatDuration} minutes long. Consecutive beats MUST NOT leave a gap larger than one beat's duration (${beatDuration} min) — cover the full runtime.

For each beat:
- Use the PLOT to decide what happens and which characters are involved.
- Use the REVIEWS to decide how to score that part of the film (1.0–10.0) and to write reviewEvidence.
- Write a CONVERSATIONAL label that names specific characters and specific events from the plot. Labels should read like how a moviegoer would describe the scene to a friend.

## Anti-patterns — DO NOT do any of these

- DO NOT use generic genre-template labels. Bad: "Meeting the protagonist", "Act two turning point", "The climax", "Setting the scene", "The payoff", "How it ends".
- DO NOT use screenwriting jargon: "Act One", "Inciting Incident", "Midpoint", "Rising action", "Falling action", "All is lost", "Denouement".
- DO NOT invent events that are not described in the plot above.
- DO NOT skip mid-film sections. If the plot describes events between 30 and 60 minutes, that stretch needs beats too — do not jump from the opening straight to the climax.
- DO NOT use em dashes (— or --) in beat labels. Use commas, periods, or parentheses instead.
- DO NOT conflate emotionally dark or sad events with negative audience reception. A devastating scene can still be beloved. Score each beat on how REVIEWERS felt about that part of the film, not on the emotional tone of the events themselves.

## Scoring

Use the full 1.0–10.0 scale. Not every film is a flat 7–8. If reviewers praise a moment as transcendent, score it 9 or 10. If they call a stretch dull or weak, score it below 6. The mean of all beat scores must land within ±0.2 of the target (${target}).

## Confidence levels

- "high": Multiple reviews specifically discuss this part of the film
- "medium": Some reviews reference this section
- "low": Inferred from general sentiment, few specific references

## reviewEvidence

A 1–2 sentence paraphrased synthesis of what reviewers said about this portion of the film. NOT a direct quote. Be specific — lean on phrasings reviewers actually used.

## Output

Return EXACTLY ONE JSON object. No prose, no preamble, no markdown fences. Schema:

{
  "film": "${film.title}",
  "anchoredFrom": "${anchorString}",
  "dataPoints": [
    {
      "timeStart": <number, minutes>,
      "timeEnd": <number, minutes>,
      "timeMidpoint": <number, minutes>,
      "score": <number, 1.0–10.0>,
      "label": "<specific to this film's plot and characters, no em dashes>",
      "confidence": "low" | "medium" | "high",
      "reviewEvidence": "<1–2 sentence paraphrased synthesis>"
    }
  ],
  "overallSentiment": <number, within ±0.2 of ${target}>,
  "peakMoment": { "label": "<beat label>", "score": <number>, "time": <minutes> },
  "lowestMoment": { "label": "<beat label>", "score": <number>, "time": <minutes> },
  "biggestSentimentSwing": "<one sentence describing the biggest shift>",
  "summary": "<2–3 sentence summary of the overall sentiment arc>",
  "sources": ${JSON.stringify(sourcesArray)},
  "varianceSource": "external_only",
  "reviewCount": ${reviews.length},
  "generatedAt": "<ISO timestamp>"
}`
}

interface ParsedGraph {
  dataPoints: SentimentDataPoint[]
  overallSentiment: number
  peakMoment: PeakLowMoment
  lowestMoment: PeakLowMoment
  biggestSentimentSwing: string
  summary: string
}

function validateGraph(raw: unknown): ParsedGraph {
  if (!raw || typeof raw !== 'object') throw new Error('Response is not an object')
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.dataPoints) || obj.dataPoints.length < 10) {
    throw new Error(`Invalid data: expected 10+ data points, got ${Array.isArray(obj.dataPoints) ? obj.dataPoints.length : 0}`)
  }
  if (typeof obj.overallSentiment !== 'number') throw new Error('Missing overallSentiment')
  if (!obj.peakMoment || !obj.lowestMoment) throw new Error('Missing peak/lowest moment')
  if (typeof obj.biggestSentimentSwing !== 'string') throw new Error('Missing biggestSentimentSwing')
  if (typeof obj.summary !== 'string') throw new Error('Missing summary')
  return {
    dataPoints: obj.dataPoints as SentimentDataPoint[],
    overallSentiment: obj.overallSentiment,
    peakMoment: obj.peakMoment as PeakLowMoment,
    lowestMoment: obj.lowestMoment as PeakLowMoment,
    biggestSentimentSwing: obj.biggestSentimentSwing,
    summary: obj.summary,
  }
}

async function callClaudeAndParse(params: {
  system: string | null
  user: string
  filmId: string
  filmTitle: string
}): Promise<{ graph: ParsedGraph; inputTokens: number; outputTokens: number }> {
  const { system, user, filmId, filmTitle } = params
  let lastError: Error | null = null
  let lastRawResponse: string | undefined

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const userContent =
        attempt === 0
          ? user
          : `IMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON — no markdown fences, no preamble, no trailing text.\n\n${user}`

      const message = await anthropic.messages.create({
        model: SENTIMENT_MODEL,
        max_tokens: SENTIMENT_MAX_TOKENS,
        ...(system
          ? {
              system: [
                {
                  type: 'text' as const,
                  text: system,
                  cache_control: { type: 'ephemeral' as const },
                },
              ],
            }
          : {}),
        messages: [{ role: 'user', content: userContent }],
      })

      const responseText = message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('')
      lastRawResponse = responseText

      const cleaned = responseText
        .replace(/^```json?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim()
      const parsed = JSON.parse(cleaned) as unknown
      const graph = validateGraph(parsed)
      return {
        graph,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      pipelineLogger.warn(
        { filmId, filmTitle, attempt: attempt + 1, error: lastError.message },
        `Hybrid Claude attempt ${attempt + 1} failed`
      )
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  }

  pipelineLogger.error(
    { filmId, filmTitle, rawResponse: lastRawResponse?.slice(0, 500) },
    'Hybrid Claude analysis failed after 2 attempts'
  )
  throw new Error(`Hybrid Claude analysis failed after 2 attempts: ${lastError?.message}`)
}

/**
 * Generate a Wikipedia-plot-grounded sentiment graph for a single film.
 *
 * Fuses plot (Wikipedia — ground truth for events & characters) with reviews
 * (ground truth for emotional calibration). Falls back to the existing review-
 * only prompt when Wikipedia returns no plot.
 *
 * Pure: performs no database writes. Reads Film and Review rows.
 */
export async function generateHybridSentimentGraph(filmId: string): Promise<HybridResult> {
  const startedAt = Date.now()

  const film = await prisma.film.findUnique({ where: { id: filmId } })
  if (!film) throw new Error(`Film not found: ${filmId}`)

  if (film.releaseDate && film.releaseDate > new Date()) {
    throw new Error(
      `Cannot generate sentiment for pre-release film ${film.title}, releases ${film.releaseDate.toISOString()}`
    )
  }

  const storedReviews = await prisma.review.findMany({
    where: { filmId },
    orderBy: { fetchedAt: 'desc' },
  })
  const qualityReviews = storedReviews.filter((r) => isQualityReview(r.reviewText))

  if (qualityReviews.length < MIN_QUALITY_REVIEWS) {
    throw new Error(
      `Not enough quality reviews: ${qualityReviews.length} < ${MIN_QUALITY_REVIEWS}`
    )
  }

  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : 'Unknown'
  const runtime = film.runtime || 120

  const plotText =
    typeof year === 'number' ? await fetchWikipediaPlot(film.title, year) : null
  const plotAvailable = Boolean(plotText)
  const plotLength = plotText?.length || 0

  const anchorScores: AnchorScores = {
    imdbRating: film.imdbRating,
    rtCriticsScore: film.rtCriticsScore,
    rtAudienceScore: film.rtAudienceScore,
    metacriticScore: film.metacriticScore,
  }

  let system: string | null = null
  let user: string
  let generationMode: HybridResult['generationMode']

  if (plotText) {
    generationMode = 'hybrid'
    const { anchorString, target } = buildAnchorString(film)
    const beatCount = computeHybridBeatCount(runtime)
    user = buildHybridPrompt({
      film,
      year,
      runtime,
      anchorString,
      target,
      plotText,
      reviews: qualityReviews,
      beatCount,
    })
  } else {
    generationMode = 'review_only_fallback'
    const parts = buildAnalysisPromptParts(film, qualityReviews, anchorScores, undefined)
    system = parts.system
    user = parts.user
  }

  const { graph, inputTokens, outputTokens } = await callClaudeAndParse({
    system,
    user,
    filmId,
    filmTitle: film.title,
  })

  pipelineLogger.info(
    {
      filmId,
      filmTitle: film.title,
      generationMode,
      beatCount: graph.dataPoints.length,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - startedAt,
    },
    'Hybrid sentiment graph generated'
  )

  return {
    filmId,
    filmTitle: film.title,
    runtime,
    reviewCount: qualityReviews.length,
    wikipediaPlotAvailable: plotAvailable,
    wikipediaPlotLength: plotLength,
    beats: graph.dataPoints,
    overallScore: graph.overallSentiment,
    peakMoment: graph.peakMoment,
    lowestMoment: graph.lowestMoment,
    biggestSentimentSwing: graph.biggestSentimentSwing,
    summary: graph.summary,
    generationMode,
    durationMs: Date.now() - startedAt,
    tokenUsage: { input: inputTokens, output: outputTokens },
    prompt: { system, user },
  }
}
