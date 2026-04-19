import Anthropic from '@anthropic-ai/sdk'
import type { Film, Review } from '@/generated/prisma/client'
import type { AnchorScores } from './omdb'
import type { SentimentDataPoint, SentimentGraphData } from '@/lib/types'
import { pipelineLogger } from './logger'

export type { SentimentDataPoint, SentimentGraphData }

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY || '',
})

// Keep the model + max_tokens constants in one place so the single-call and
// batch paths can never drift apart.
export const SENTIMENT_MODEL = 'claude-sonnet-4-20250514'
export const SENTIMENT_MAX_TOKENS = 4000

// ── Pricing (USD per 1M tokens) for claude-sonnet-4-20250514 ──
// Synchronous price; Batch API charges 50% of this.
const PRICE_PER_MTOK_INPUT = 3.0
const PRICE_PER_MTOK_OUTPUT = 15.0
const PRICE_PER_MTOK_CACHE_WRITE = 3.75 // 1.25× input price for 5m TTL
const PRICE_PER_MTOK_CACHE_READ = 0.3 // 0.1× input price
const BATCH_DISCOUNT = 0.5

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/**
 * Estimate the USD cost of a sentiment-analysis call (single or batch),
 * factoring in cache reads/writes and the Batch API discount.
 */
export function estimateSentimentCost(usage: UsageTotals, opts: { isBatch: boolean }): number {
  const discount = opts.isBatch ? BATCH_DISCOUNT : 1.0
  return (
    (usage.inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT * discount +
    (usage.outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT * discount +
    (usage.cacheCreationInputTokens / 1_000_000) * PRICE_PER_MTOK_CACHE_WRITE * discount +
    (usage.cacheReadInputTokens / 1_000_000) * PRICE_PER_MTOK_CACHE_READ * discount
  )
}

export function sumUsage(usages: Iterable<UsageTotals>): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
  for (const u of usages) {
    totals.inputTokens += u.inputTokens
    totals.outputTokens += u.outputTokens
    totals.cacheReadInputTokens += u.cacheReadInputTokens
    totals.cacheCreationInputTokens += u.cacheCreationInputTokens
  }
  return totals
}

export interface PlotContext {
  text: string
  source: 'wikipedia' | 'tmdb' | 'omdb' | 'reviews_only'
}

export interface AnalysisPromptParts {
  /** Stable instructions, scoring scale, output schema. Identical for every
   *  film, so it is the cacheable portion. */
  system: string
  /** Per-film variable data: title, scores, plot context, review block. */
  user: string
}

/**
 * Stable instruction block. Identical for every film, so it is a perfect
 * candidate for prompt caching with `cache_control: 'ephemeral'`. Must be
 * ≥1024 tokens for Sonnet caching to apply — keep that in mind if editing.
 */
export const SENTIMENT_SYSTEM_PROMPT = `You are a film sentiment analyst. Your job is to analyze audience reviews of a film and produce a sentiment graph showing how viewer opinion shifts across the runtime, expressed as a series of data points spanning the full duration.

## Output

You ALWAYS return EXACTLY ONE JSON object. No prose, no preamble, no markdown code fences. Just the raw JSON. The schema is:

{
  "film": "<film title>",
  "anchoredFrom": "<formatted anchor scores>",
  "dataPoints": [
    {
      "timeStart": <number, minutes>,
      "timeEnd": <number, minutes>,
      "timeMidpoint": <number, minutes>,
      "score": <number, 1.0–10.0>,
      "label": "<2-5 word short memory anchor, no em dashes>",
      "labelFull": "<4-10 word descriptive label for the same event, no em dashes>",
      "confidence": "low" | "medium" | "high",
      "reviewEvidence": "<1–2 sentence synthesis of what reviewers said>"
    }
  ],
  "overallSentiment": <number, 1.0–10.0>,
  "peakMoment": { "label": "<short anchor>", "labelFull": "<descriptive>", "score": <number>, "time": <number> },
  "lowestMoment": { "label": "<short anchor>", "labelFull": "<descriptive>", "score": <number>, "time": <number> },
  "biggestSentimentSwing": "<description of biggest shift>",
  "summary": "<2–3 sentence summary of the overall sentiment arc>",
  "sources": [<lowercase source platform names>],
  "varianceSource": "external_only",
  "reviewCount": <number>,
  "generatedAt": "<ISO timestamp>"
}

## Scoring scale (always use the FULL scale)

- 1–2: Terrible, hated it
- 3–4: Poor, disappointing
- 5: Neutral, mixed
- 6–7: Good, enjoyable
- 8–9: Great, impressive
- 10: Masterpiece moment

USE THE FULL SCALE. Not every film is a flat 7–9. If reviews mention weak parts, go below 6. If there are transcendent moments, use 9 or 10. Films with broadly negative consensus should land below 5 on average. Films with broadly mediocre consensus should land near 5 or 6. The shape of the curve matters: a film that opens slowly and builds to a great climax should look very different from a film that starts strong and falls apart.

## Anchoring to the target

The OVERALL average of all data points must be within ±0.2 of the target score the user gives you. The target is derived from aggregate review scores (IMDb, Rotten Tomatoes, Metacritic) and grounds the analysis to consensus reception. Treat the target as a hard constraint — your individual segment scores can vary widely, but their mean must land in the ±0.2 window.

## Confidence levels

- "high": Multiple reviews specifically discuss this part of the film
- "medium": Some reviews reference this section
- "low": Inferred from general sentiment, few specific references

## How to write labels (TWO labels per beat)

Every beat carries TWO labels describing the same event:

- \`label\`: a SHORT 2-5 word memory anchor. The iconic name of the scene as viewers remember it. Examples: "The Chokey", "Trinity test", "Bogtrotter's cake", "Einstein at the pond", "Grace meets Rocky".
- \`labelFull\`: a FULLER 4-10 word description that names the characters, event, and object or place specifically. Reads like someone describing what happened, accurately. Examples: "The Chokey is introduced as Trunchbull's punishment", "Trinity test detonates in the New Mexico desert", "Bruce Bogtrotter forced to eat the chocolate cake", "Oppenheimer meets Einstein at the pond", "Grace meets Rocky for the first time in the Eridian spacecraft".

Both labels must describe the SAME event. They are two angles on one beat, not two different beats. Write the \`labelFull\` first — specific, accurate, descriptive — then compress it into the short \`label\` without drifting to a different scene or a more generic phrasing.

Core principles for both:

1. Real names, real events. Characters by name (Bruce Bogtrotter, Rocky, Kitty, Grace), places by name (Los Alamos, Crunchem Hall), objects by name (the chocolate cake, the Trinity test, the astrophage). Never abstract nouns like "confrontation", "turning point", "resolution".

2. \`labelFull\` prioritizes descriptive accuracy. It should work for a viewer who remembers the film vaguely as well as one who remembers it clearly. Do not write \`labelFull\` as a longer restatement of the short \`label\` — write it as the actual description of what happens.

3. \`label\` is the minimum viable phrase that identifies the scene. Readers who know the film recognize it instantly; readers who don't can still use \`labelFull\` to understand.

4. Do not let \`label\` drift from \`labelFull\`. If \`labelFull\` says "Kitty testifies at the security clearance hearing", \`label\` should be "Kitty's testimony" — not "The hearing" (ambiguous) or "A courtroom moment" (vague).

Examples of good (label, labelFull) pairs:

- "The Bogtrotter cake" | "Bruce Bogtrotter forced to eat the chocolate cake"
- "The Chokey" | "The Chokey is introduced as Trunchbull's punishment"
- "Miss Honey's backstory" | "Miss Honey reveals her tragic backstory about Trunchbull"
- "Trinity test" | "Trinity test detonates in the New Mexico desert"
- "Einstein at the pond" | "Oppenheimer meets Einstein at the pond for their final conversation"
- "Grace meets Rocky" | "Grace meets Rocky for the first time in the Eridian spacecraft"
- "Grace drugged" | "Grace is drugged and loaded onto the Hail Mary"
- "Kitty's testimony" | "Kitty testifies at the security clearance hearing"
- "Trunchbull's defeat" | "Matilda uses telekinetic powers to drive Trunchbull away"
- "Strauss loses confirmation" | "Strauss loses his Senate confirmation vote"

Hard requirements:

- Both \`label\` AND \`labelFull\` required on every beat. No empty strings. No nulls. No omissions.
- \`label\` is 2-5 words. \`labelFull\` is 4-10 words (longer only if the scene genuinely requires it).
- Both must name specific characters, events, and places from the film. Accuracy is non-negotiable.
- No generic genre-template labels ("Meeting the protagonist", "The climax", "How it ends", "Setting the scene", etc.) in EITHER field.
- No screenwriting jargon ("Inciting Incident", "Act One", "Midpoint", etc.) in EITHER field.
- No em dashes in either label. Use commas, periods, or parentheses.
- \`peakMoment\` and \`lowestMoment\` also require BOTH \`label\` and \`labelFull\`, matching the corresponding beat.

When a plot synopsis is provided, ground both labels in actual scenes, characters, and moments from the film. When only reviews are available, still name specific characters, events, and places whenever the reviews mention them — do not fall back to generic phrasings.

## Critical: tone vs reception

Do NOT conflate emotionally dark or sad plot events with negative audience reception. A scene can be devastating, tragic, or upsetting and still be beloved by audiences. Score every segment based on REVIEWER SENTIMENT toward that part of the film, NOT the emotional tone of the events themselves. A funeral scene that critics call masterful should score high. A "happy" sequence that reviewers found shallow or boring should score low.

## reviewEvidence

A 1–2 sentence synthesis of what reviewers actually said about this portion of the film. NOT a direct quote — your own paraphrased summary. Be specific. Lean on phrasings reviewers actually used.

## Process

1. Read every review carefully and identify what viewers praised and criticized at different points in the film.
2. Generate the requested number of data points spanning the full runtime, in chronological order.
3. Each data point covers a roughly equal slice of the runtime. timeStart, timeEnd, and timeMidpoint must be consistent (midpoint = (start+end)/2).
4. Score each segment using the full 1–10 scale.
5. Verify the average of your scores lands within ±0.2 of the target the user supplied.
6. Pick the highest-scoring segment as peakMoment and the lowest as lowestMoment. Each gets both label and labelFull (matching the corresponding beat), plus score and time (in minutes).
7. Identify the biggest sentiment swing — the largest shift between adjacent or near-adjacent segments — and describe it in one sentence.
8. Write a 2–3 sentence summary of the overall sentiment arc.
9. Return ONLY the JSON object. No markdown fences, no explanations, no preamble, no trailing text. Your entire response must parse as JSON on the first try.`

export function buildAnalysisPromptParts(
  film: Film,
  reviews: Review[],
  anchorScores: AnchorScores,
  plotContext?: PlotContext
): AnalysisPromptParts {
  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : 'Unknown'
  const runtime = film.runtime || 120

  // Anchor string + target score
  const anchors: string[] = []
  const primaryAnchor = anchorScores.imdbRating || (film.imdbRating as number | null)
  if (primaryAnchor) anchors.push(`IMDb ${primaryAnchor}`)
  if (anchorScores.rtCriticsScore) anchors.push(`RT ${anchorScores.rtCriticsScore}%`)
  if (anchorScores.metacriticScore) anchors.push(`MC ${anchorScores.metacriticScore}`)
  const anchorString = anchors.join(' | ') || 'No anchor scores available'
  const targetScore = primaryAnchor || 7.0

  // Review block
  const reviewBlock = reviews
    .slice(0, 40)
    .map(
      (r, i) =>
        `[Review ${i + 1} — ${r.sourcePlatform}${r.sourceRating ? ` (${r.sourceRating}/10)` : ''}${r.author ? ` by ${r.author}` : ''}]\n${r.reviewText.slice(0, 1500)}`
    )
    .join('\n\n---\n\n')

  // Segment count: 14–18 depending on runtime
  const segmentCount = Math.min(Math.max(14, Math.round(runtime / 8)), 18)
  const segmentDuration = runtime / segmentCount

  // Optional plot section
  const plotSection =
    plotContext && plotContext.source !== 'reviews_only'
      ? `\n## Plot Synopsis (source: ${plotContext.source})\n\n${plotContext.text.slice(0, 4000)}\n\nUse this plot summary to ground your beat labels in specific scenes, characters, and moments from this film.\n`
      : ''

  const sourcesArray = [...new Set(reviews.map((r) => r.sourcePlatform.toLowerCase()))]

  const user = `Analyze the following reviews for "${film.title}" (${year}) and generate a sentiment graph for its ${runtime}-minute runtime.

## Film Information
- Title: ${film.title}
- Director: ${film.director || 'Unknown'}
- Year: ${year}
- Runtime: ${runtime} minutes
- Genres: ${film.genres?.join(', ') || 'Unknown'}

## Aggregate Scores (ANCHOR — your overall must be within ±0.2 of the IMDb score)
${anchorString}
Target overall sentiment: ${targetScore} (±0.2 variance allowed)
${plotSection}
## Required Output

Generate exactly ${segmentCount} data points spanning 0 to ${runtime} minutes (each ~${Math.round(segmentDuration)} minutes long).

Use these exact literal values in your output:
- "film": "${film.title}"
- "anchoredFrom": "${anchorString}"
- "sources": ${JSON.stringify(sourcesArray)}
- "varianceSource": "external_only"
- "reviewCount": ${reviews.length}
- "generatedAt": "${new Date().toISOString()}"

## Reviews to Analyze

${reviewBlock}`

  return { system: SENTIMENT_SYSTEM_PROMPT, user }
}

/** Server-controlled fields that we force onto every parsed graph response,
 *  regardless of what the model returns. */
export interface ParseGraphContext {
  reviewCount: number
  /** Lowercase source platform names (e.g. ['tmdb', 'imdb']). */
  sources: string[]
}

function reviewsToContext(reviews: Review[]): ParseGraphContext {
  return {
    reviewCount: reviews.length,
    sources: [...new Set(reviews.map((r) => r.sourcePlatform.toLowerCase()))],
  }
}

// Mirrors hybrid-sentiment.ts's assertLabelPair so the two entry points into
// the sentiment pipeline enforce the same dual-label strictness. Kept inline
// (not imported) to avoid a cross-module dependency: hybrid-sentiment.ts
// already imports from claude.ts, and reversing that would create a cycle.
function assertLabelPair(obj: unknown, where: string): void {
  if (!obj || typeof obj !== 'object') {
    throw new Error(`parseGraphResponse: ${where} is not an object`)
  }
  const o = obj as Record<string, unknown>
  if (typeof o.label !== 'string' || o.label.trim() === '') {
    throw new Error(`parseGraphResponse: ${where} missing or empty label`)
  }
  if (typeof o.labelFull !== 'string' || o.labelFull.trim() === '') {
    throw new Error(`parseGraphResponse: ${where} missing or empty labelFull`)
  }
}

function parseGraphResponse(rawResponse: string, ctx: ParseGraphContext): SentimentGraphData {
  // Strip any accidental markdown fences (the system prompt forbids them, but
  // models slip up).
  const cleaned = rawResponse
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const data = JSON.parse(cleaned) as SentimentGraphData

  if (!data.dataPoints || !Array.isArray(data.dataPoints) || data.dataPoints.length < 10) {
    throw new Error(`Invalid data: expected 10+ data points, got ${data.dataPoints?.length || 0}`)
  }

  for (let i = 0; i < data.dataPoints.length; i++) {
    assertLabelPair(data.dataPoints[i], `dataPoints[${i}]`)
  }

  if (typeof data.overallSentiment !== 'number') {
    throw new Error('Missing overallSentiment')
  }

  if (!data.peakMoment || !data.lowestMoment) {
    throw new Error('Missing peak/lowest moment')
  }
  assertLabelPair(data.peakMoment, 'peakMoment')
  assertLabelPair(data.lowestMoment, 'lowestMoment')

  // Force trusted server-controlled fields (cheaper than asking the model to
  // be careful, and avoids drift between the prompt template and the schema).
  data.varianceSource = 'external_only'
  data.reviewCount = ctx.reviewCount
  data.generatedAt = new Date().toISOString()
  data.sources = ctx.sources

  return data
}

export async function analyzeSentiment(
  film: Film,
  reviews: Review[],
  anchorScores: AnchorScores,
  plotContext?: PlotContext
): Promise<SentimentGraphData> {
  const { system, user } = buildAnalysisPromptParts(film, reviews, anchorScores, plotContext)

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
        temperature: 0,
        system: [
          {
            type: 'text',
            text: system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userContent }],
      })

      const responseText = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')

      lastRawResponse = responseText
      return parseGraphResponse(responseText, reviewsToContext(reviews))
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      pipelineLogger.error(
        { filmId: film.id, attempt: attempt + 1, error: lastError.message },
        `Claude attempt ${attempt + 1} failed`
      )
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  }

  pipelineLogger.error(
    { filmId: film.id, filmTitle: film.title, rawResponse: lastRawResponse?.slice(0, 500) },
    'Claude analysis failed after 2 attempts'
  )
  throw new Error(`Claude analysis failed after 2 attempts: ${lastError?.message}`)
}

// ── Batch API support ───────────────────────────────────────────────────────

export interface BatchJob {
  /** Stable identifier used to match a result back to its caller. We use
   *  filmId as the customId in the cron, but this helper is agnostic. */
  customId: string
  system: string
  user: string
}

export interface BatchSubmitResult {
  batchId: string
  submittedAt: string
}

/**
 * Submit a batch of sentiment analyses via Anthropic's Message Batches API.
 * Each job becomes a separate request within the batch and gets the same
 * cached system prompt, so the first request writes the cache and subsequent
 * requests read it (within the 5-minute TTL). On top of caching, the Batch
 * API itself charges roughly half the synchronous price for the same tokens.
 */
export async function analyzeSentimentBatch(jobs: BatchJob[]): Promise<BatchSubmitResult> {
  if (jobs.length === 0) {
    throw new Error('analyzeSentimentBatch called with no jobs')
  }

  const batch = await anthropic.messages.batches.create({
    requests: jobs.map((job) => ({
      custom_id: job.customId,
      params: {
        model: SENTIMENT_MODEL,
        max_tokens: SENTIMENT_MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: job.system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: job.user }],
      },
    })),
  })

  pipelineLogger.info(
    { batchId: batch.id, requestCount: jobs.length },
    'Submitted Anthropic sentiment batch'
  )

  return { batchId: batch.id, submittedAt: batch.created_at }
}

export interface BatchStatus {
  processingStatus: 'in_progress' | 'canceling' | 'ended'
  requestCounts: {
    processing: number
    succeeded: number
    errored: number
    canceled: number
    expired: number
  }
}

export async function getBatchStatus(batchId: string): Promise<BatchStatus> {
  const batch = await anthropic.messages.batches.retrieve(batchId)
  return {
    processingStatus: batch.processing_status,
    requestCounts: {
      processing: batch.request_counts.processing,
      succeeded: batch.request_counts.succeeded,
      errored: batch.request_counts.errored,
      canceled: batch.request_counts.canceled,
      expired: batch.request_counts.expired,
    },
  }
}

export interface BatchResultEntry {
  customId: string
  outcome: 'succeeded' | 'errored' | 'canceled' | 'expired'
  data?: SentimentGraphData
  error?: string
  usage?: UsageTotals
}

/**
 * Stream and parse all results from a completed batch. The caller passes in a
 * `contextByCustomId` map so we can coerce the trusted server-controlled
 * fields (sources, reviewCount) onto each parsed result. Storing only the
 * minimal context — instead of full Review[] — lets the caller persist batch
 * state in a small JSON blob.
 */
export async function fetchBatchResults(
  batchId: string,
  contextByCustomId: Map<string, ParseGraphContext>
): Promise<BatchResultEntry[]> {
  const decoder = await anthropic.messages.batches.results(batchId)
  const out: BatchResultEntry[] = []

  for await (const entry of decoder) {
    const customId = entry.custom_id
    const result = entry.result

    if (result.type === 'succeeded') {
      const message = result.message
      const responseText = message.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')

      try {
        const ctx = contextByCustomId.get(customId) ?? { reviewCount: 0, sources: [] }
        const data = parseGraphResponse(responseText, ctx)
        out.push({
          customId,
          outcome: 'succeeded',
          data,
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
          },
        })
      } catch (err) {
        out.push({
          customId,
          outcome: 'errored',
          error: `Parse failure: ${err instanceof Error ? err.message : String(err)}`,
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
          },
        })
      }
    } else if (result.type === 'errored') {
      out.push({
        customId,
        outcome: 'errored',
        error: result.error.error.message ?? 'Unknown batch request error',
      })
    } else {
      // canceled | expired
      out.push({ customId, outcome: result.type })
    }
  }

  return out
}
