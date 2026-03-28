import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import Anthropic from '@anthropic-ai/sdk'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY
if (!apiKey) { console.error('No Anthropic API key found'); process.exit(1) }
const anthropic = new Anthropic({ apiKey })

// ── Test films ──
const TEST_FILMS = [
  { title: 'Inception', year: 2010 },
  { title: 'The Godfather', year: 1972 },
  { title: 'Thunderbolts*', year: 2025 },
  { title: 'The Dark Knight', year: 2008 },
  { title: 'Parasite', year: 2019 },
  { title: 'Titanic', year: 1997 },
]

// ── Wikipedia fetcher ──
async function fetchWikipediaPlot(title: string, year: number): Promise<string | null> {
  const slugs = [
    `${title.replace(/\*/g, '')} (${year} film)`,
    `${title.replace(/\*/g, '')} (film)`,
    title.replace(/\*/g, ''),
  ]

  for (const slug of slugs) {
    const encoded = encodeURIComponent(slug.replace(/ /g, '_'))
    const url = `https://en.wikipedia.org/api/rest_v1/page/html/${encoded}`
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Cinemagraphs/1.0 (cinemagraphs.ca; test script)' },
      })
      if (!res.ok) continue
      const html = await res.text()

      // Extract the Plot section from the HTML
      const plotMatch = html.match(/<section[^>]*>[\s\S]*?<h2[^>]*>[^<]*Plot[^<]*<\/h2>([\s\S]*?)<\/section>/i)
      if (!plotMatch) continue

      // Strip HTML tags to get plain text
      const plotText = plotMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/&#\d+;/g, '')
        .replace(/&[a-z]+;/g, ' ')
        .trim()

      if (plotText.length > 100) {
        console.log(`  Wikipedia: found plot via "${slug}" (${plotText.length} chars)`)
        return plotText
      }
    } catch {
      continue
    }
  }
  console.log(`  Wikipedia: no plot found for "${title}"`)
  return null
}

// ── Quality filter (same as pipeline) ──
const ENGLISH_REGEX = /^[\x00-\x7F\u00C0-\u024F\u2018-\u201D\u2014\u2013\u2026\s.,;:!?'"()\-[\]{}@#$%^&*+=/<>~`|\\]+$/
const MIN_WORD_COUNT = 50

function isQualityReview(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (words.length < MIN_WORD_COUNT) return false
  if (!ENGLISH_REGEX.test(text.slice(0, 500))) return false
  return true
}

// ── Build prompt (matches claude.ts but with optional Wikipedia plot) ──
function buildPrompt(
  film: any,
  reviews: any[],
  wikipediaPlot: string | null
): string {
  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : 'Unknown'
  const runtime = film.runtime || 120

  const anchors: string[] = []
  if (film.imdbRating) anchors.push(`IMDb ${film.imdbRating}`)
  if (film.rtCriticsScore) anchors.push(`RT ${film.rtCriticsScore}%`)
  if (film.metacriticScore) anchors.push(`MC ${film.metacriticScore}`)
  const anchorString = anchors.join(' | ') || 'No anchor scores available'
  const targetScore = film.imdbRating || 7.0

  const segmentCount = Math.min(Math.max(14, Math.round(runtime / 8)), 18)
  const segmentDuration = runtime / segmentCount

  const reviewBlock = reviews
    .slice(0, 40)
    .map((r: any, i: number) => `[Review ${i + 1} — ${r.sourcePlatform}${r.sourceRating ? ` (${r.sourceRating}/10)` : ''}${r.author ? ` by ${r.author}` : ''}]\n${r.reviewText.slice(0, 1500)}`)
    .join('\n\n---\n\n')

  const wikiSection = wikipediaPlot
    ? `\n## Wikipedia Plot Synopsis (use for accurate timeline placement)\n\n${wikipediaPlot.slice(0, 4000)}\n`
    : ''

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
${wikiSection}
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
8. reviewEvidence: A 1-2 sentence synthesis of what reviewers said about this portion (not a direct quote).${wikipediaPlot ? '\n9. Use the Wikipedia plot synopsis to accurately place sentiment shifts at the correct timestamps. Match review comments to specific plot events.' : ''}

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
  "sources": ${JSON.stringify([...new Set(reviews.map((r: any) => r.sourcePlatform.toLowerCase()))])},
  "varianceSource": "external_only",
  "reviewCount": ${reviews.length},
  "generatedAt": "${new Date().toISOString()}"
}`
}

// ── Call Claude and parse ──
async function callClaude(prompt: string): Promise<any> {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('')
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
  return JSON.parse(cleaned)
}

// ── Format comparison table ──
function printComparison(
  filmTitle: string,
  currentBeats: any[] | null,
  wikiBeats: any[] | null,
  currentSummary: string | null,
  wikiSummary: string | null,
  currentOverall: number | null,
  wikiOverall: number | null
) {
  const divider = '═'.repeat(100)
  const thinDivider = '─'.repeat(100)

  console.log(`\n${divider}`)
  console.log(`  ${filmTitle}`)
  console.log(`${divider}`)

  if (!currentBeats) {
    console.log('  No current beats in database — showing Wikipedia-enhanced only\n')
  }

  // Print overall scores
  console.log(`  Overall Score:  Current: ${currentOverall ?? 'N/A'}  |  Wiki-enhanced: ${wikiOverall ?? 'N/A'}`)
  console.log(thinDivider)

  // Print beats side by side
  const maxLen = Math.max(currentBeats?.length || 0, wikiBeats?.length || 0)

  console.log(`  ${'CURRENT BEATS'.padEnd(48)} | ${'WIKIPEDIA-ENHANCED BEATS'}`)
  console.log(`  ${'Time   Score  Label'.padEnd(48)} | ${'Time   Score  Label'}`)
  console.log(`  ${thinDivider}`)

  for (let i = 0; i < maxLen; i++) {
    const curr = currentBeats?.[i]
    const wiki = wikiBeats?.[i]

    const currStr = curr
      ? `${String(curr.timeStart).padStart(3)}-${String(curr.timeEnd).padEnd(3)}  ${String(curr.score).padEnd(5)}  ${(curr.label || '').slice(0, 32)}`
      : ''
    const wikiStr = wiki
      ? `${String(wiki.timeStart).padStart(3)}-${String(wiki.timeEnd).padEnd(3)}  ${String(wiki.score).padEnd(5)}  ${(wiki.label || '').slice(0, 32)}`
      : ''

    const scoreDiff = curr && wiki ? (wiki.score - curr.score) : null
    const diffStr = scoreDiff !== null ? (scoreDiff >= 0 ? ` (+${scoreDiff.toFixed(1)})` : ` (${scoreDiff.toFixed(1)})`) : ''

    console.log(`  ${currStr.padEnd(48)} | ${wikiStr}${diffStr}`)
  }

  console.log(thinDivider)

  // Print summaries
  if (currentSummary) {
    console.log(`  Current summary:  ${currentSummary}`)
  }
  if (wikiSummary) {
    console.log(`  Wiki summary:     ${wikiSummary}`)
  }

  // Print evidence comparison for a few beats
  if (wikiBeats && wikiBeats.length > 0) {
    console.log(`\n  Sample evidence (wiki-enhanced):`)
    for (const beat of wikiBeats.slice(0, 3)) {
      console.log(`    [${beat.timeStart}-${beat.timeEnd}min] ${beat.label}: ${beat.reviewEvidence}`)
    }
  }

  console.log('')
}

// ── Main ──
async function main() {
  console.log('Wikipedia Beat Generation Test')
  console.log('Read-only — nothing will be saved to the database\n')

  for (const { title, year } of TEST_FILMS) {
    console.log(`\n--- Processing: ${title} (${year}) ---`)

    // Find film in DB
    const film = await prisma.film.findFirst({
      where: {
        title: { contains: title.replace(/\*/g, ''), mode: 'insensitive' },
      },
      include: {
        sentimentGraph: true,
        reviews: true,
      },
    })

    if (!film) {
      console.log(`  Film not found in database — skipping`)
      continue
    }

    console.log(`  Found: ${film.title} (${film.runtime}min, ${film.reviews.length} reviews)`)

    // Get quality reviews
    const qualityReviews = film.reviews.filter(r => isQualityReview(r.reviewText))
    console.log(`  Quality reviews: ${qualityReviews.length}/${film.reviews.length}`)

    if (qualityReviews.length < 1) {
      console.log(`  No quality reviews — skipping`)
      continue
    }

    // Get current beats from DB
    const currentBeats = film.sentimentGraph?.dataPoints as any[] | null
    const currentSummary = film.sentimentGraph?.summary || null
    const currentOverall = film.sentimentGraph?.overallScore || null

    // Fetch Wikipedia plot
    const wikiPlot = await fetchWikipediaPlot(title, year)

    // Generate wiki-enhanced beats
    console.log(`  Generating wiki-enhanced beats via Claude...`)
    try {
      const prompt = buildPrompt(film, qualityReviews, wikiPlot)
      const wikiResult = await callClaude(prompt)

      printComparison(
        film.title,
        currentBeats,
        wikiResult.dataPoints,
        currentSummary,
        wikiResult.summary,
        currentOverall,
        wikiResult.overallSentiment
      )
    } catch (err) {
      console.error(`  Claude analysis failed: ${err instanceof Error ? err.message : err}`)
    }

    // Pause between API calls
    await new Promise(resolve => setTimeout(resolve, 2000))
  }

  console.log('\n=== Test complete — nothing was saved ===')
  process.exit(0)
}

main()
