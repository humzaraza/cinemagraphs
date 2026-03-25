import Anthropic from '@anthropic-ai/sdk'
import type { Film, Review } from '@/generated/prisma/client'
import type { AnchorScores } from './omdb'
import type { SentimentDataPoint, SentimentGraphData } from '@/lib/types'
import { pipelineLogger } from './logger'

export type { SentimentDataPoint, SentimentGraphData }

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY || '',
})

function buildAnalysisPrompt(
  film: Film,
  reviews: Review[],
  anchorScores: AnchorScores
): string {
  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : 'Unknown'
  const runtime = film.runtime || 120

  // Build anchor string
  const anchors: string[] = []
  const primaryAnchor = anchorScores.imdbRating || (film.imdbRating as number | null)
  if (primaryAnchor) anchors.push(`IMDb ${primaryAnchor}`)
  if (anchorScores.rtCriticsScore) anchors.push(`RT ${anchorScores.rtCriticsScore}%`)
  if (anchorScores.metacriticScore) anchors.push(`MC ${anchorScores.metacriticScore}`)
  const anchorString = anchors.join(' | ') || 'No anchor scores available'

  // Calculate target overall score from anchor
  const targetScore = primaryAnchor || 7.0

  // Build review text block
  const reviewBlock = reviews
    .slice(0, 40) // Limit to avoid token overflow
    .map((r, i) => `[Review ${i + 1} — ${r.sourcePlatform}${r.sourceRating ? ` (${r.sourceRating}/10)` : ''}${r.author ? ` by ${r.author}` : ''}]\n${r.reviewText.slice(0, 1500)}`)
    .join('\n\n---\n\n')

  // Calculate time segments
  const segmentCount = Math.min(Math.max(14, Math.round(runtime / 8)), 18)
  const segmentDuration = runtime / segmentCount

  return `You are a film sentiment analyst. Analyze the following reviews for "${film.title}" (${year}) and generate a sentiment graph showing how audience opinion shifts across the film's ${runtime}-minute runtime.

## Film Information
- Title: ${film.title}
- Director: ${film.director || 'Unknown'}
- Year: ${year}
- Runtime: ${runtime} minutes
- Genres: ${film.genres?.join(', ') || 'Unknown'}

## Aggregate Scores (ANCHOR — your overall must be within ±0.2 of the IMDb score)
${anchorString}
Target overall sentiment: ${targetScore} (±0.2 variance allowed)

## Instructions

1. Read ALL reviews carefully and identify what viewers praised and criticized at different points in the film.
2. Generate exactly ${segmentCount} data points spanning the full runtime (0 to ${runtime} minutes), each covering ~${Math.round(segmentDuration)} minutes.
3. For each segment, determine a sentiment score on a 1-10 scale:
   - 1-2: Terrible, hated it
   - 3-4: Poor, disappointing
   - 5: Neutral, mixed
   - 6-7: Good, enjoyable
   - 8-9: Great, impressive
   - 10: Masterpiece moment
4. USE THE FULL SCALE. Not every film is 7-9. If reviews mention weak parts, go below 6. If there are transcendent moments, use 9-10.
5. The OVERALL average of all data points must be within ±0.2 of ${targetScore}.
6. Each data point needs a CONVERSATIONAL label — plain language that any moviegoer would understand. Examples:
   - "How does it start?" / "Setting the scene" / "Meeting the characters"
   - "Things get interesting" / "The big twist" / "Everything changes"
   - "The emotional peak" / "Heart-wrenching moment" / "Pure cinema"
   - "How does it end?" / "The payoff" / "Final thoughts"
   DO NOT use screenwriting jargon like "Act One", "Inciting Incident", "Midpoint", "Climax", "Denouement".
7. Confidence levels:
   - "high": Multiple reviews specifically discuss this part of the film
   - "medium": Some reviews reference this section
   - "low": Inferred from general sentiment, few specific references
8. reviewEvidence: A 1-2 sentence synthesis of what reviewers said about this portion (not a direct quote).

## Reviews to Analyze

${reviewBlock}

## Required Output Format

Return ONLY valid JSON (no markdown, no code fences, no explanation) matching this exact structure:

{
  "film": "${film.title}",
  "anchoredFrom": "${anchorString}",
  "dataPoints": [
    {
      "timeStart": 0,
      "timeEnd": ${Math.round(segmentDuration)},
      "timeMidpoint": ${Math.round(segmentDuration / 2)},
      "score": 7.5,
      "label": "Setting the scene",
      "confidence": "medium",
      "reviewEvidence": "Reviewers noted the opening establishes..."
    }
  ],
  "overallSentiment": ${targetScore},
  "peakMoment": { "label": "The big moment", "score": 9.2, "time": 95 },
  "lowestMoment": { "label": "A slow stretch", "score": 5.5, "time": 45 },
  "biggestSentimentSwing": "Description of the biggest shift in audience opinion",
  "summary": "2-3 sentence summary of the overall sentiment arc",
  "sources": ${JSON.stringify([...new Set(reviews.map(r => r.sourcePlatform.toLowerCase()))])},
  "varianceSource": "external_only",
  "reviewCount": ${reviews.length},
  "generatedAt": "${new Date().toISOString()}"
}`
}

export async function analyzeSentiment(
  film: Film,
  reviews: Review[],
  anchorScores: AnchorScores
): Promise<SentimentGraphData> {
  const prompt = buildAnalysisPrompt(film, reviews, anchorScores)

  let lastError: Error | null = null
  let lastRawResponse: string | undefined

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const currentPrompt = attempt === 0
        ? prompt
        : `IMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON — no markdown fences, no preamble, no trailing text.\n\n${prompt}`

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: currentPrompt }],
      })

      const responseText = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')

      lastRawResponse = responseText

      // Strip any accidental markdown fences
      const cleaned = responseText
        .replace(/^```json?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim()

      const data = JSON.parse(cleaned) as SentimentGraphData

      // Validate structure
      if (!data.dataPoints || !Array.isArray(data.dataPoints) || data.dataPoints.length < 10) {
        throw new Error(`Invalid data: expected 10+ data points, got ${data.dataPoints?.length || 0}`)
      }

      if (typeof data.overallSentiment !== 'number') {
        throw new Error('Missing overallSentiment')
      }

      // Ensure required fields
      data.varianceSource = 'external_only'
      data.reviewCount = reviews.length
      data.generatedAt = new Date().toISOString()
      data.sources = [...new Set(reviews.map(r => r.sourcePlatform.toLowerCase()))]

      return data
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      pipelineLogger.error(
        { filmId: film.id, attempt: attempt + 1, error: lastError.message },
        `Claude attempt ${attempt + 1} failed`
      )
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }

  pipelineLogger.error(
    { filmId: film.id, filmTitle: film.title, rawResponse: lastRawResponse?.slice(0, 500) },
    'Claude analysis failed after 2 attempts'
  )
  throw new Error(`Claude analysis failed after 2 attempts: ${lastError?.message}`)
}
