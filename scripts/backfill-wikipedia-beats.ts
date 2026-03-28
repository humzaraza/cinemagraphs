import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import Anthropic from '@anthropic-ai/sdk'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY
if (!apiKey) { console.error('No Anthropic API key found'); process.exit(1) }
const anthropic = new Anthropic({ apiKey })

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'
const OMDB_API_KEY = process.env.OMDB_API_KEY

// ── Wikipedia fetcher ──
function cleanWikitext(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/{{[^}]*}}/g, '')
    .replace(/'{2,3}/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref[^/]*\/>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n+/g, ' ')
    .trim()
}

async function fetchWikipediaPlot(filmTitle: string, year: number): Promise<string | null> {
  const cleanTitle = filmTitle.replace(/\*/g, '')
  const slugs = [
    `${cleanTitle} (${year} film)`,
    `${cleanTitle} (film)`,
    cleanTitle,
  ]

  for (const slug of slugs) {
    try {
      const title = slug.replace(/ /g, '_')
      const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json&redirects=true`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Cinemagraphs/1.0 (https://cinemagraphs.ca; backfill script)' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) continue
      const data = await res.json()
      const pages = data?.query?.pages
      if (!pages) continue
      const page = Object.values(pages)[0] as any
      if (page?.missing !== undefined) continue
      const wikitext: string = page?.revisions?.[0]?.slots?.main?.['*'] || ''
      if (!wikitext || wikitext.startsWith('#REDIRECT')) continue

      const plotMatch = wikitext.match(/==\s*Plot\s*==\s*\n([\s\S]*?)(?:\n==\s*[^=]|$)/)
      if (!plotMatch?.[1]) continue
      const plotText = cleanWikitext(plotMatch[1])
      if (plotText.length >= 100) return plotText
    } catch {
      continue
    }
  }
  return null
}

// ── Plot context fallback chain ──
interface PlotContext {
  text: string
  source: 'wikipedia' | 'tmdb' | 'omdb' | 'reviews_only'
}

async function fetchPlotContext(film: any): Promise<PlotContext> {
  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : new Date().getFullYear()

  // 1. Wikipedia
  const wikiPlot = await fetchWikipediaPlot(film.title, year)
  if (wikiPlot) return { text: wikiPlot, source: 'wikipedia' }

  // 2. TMDB overview + tagline
  try {
    const res = await fetch(`${TMDB_BASE_URL}/movie/${film.tmdbId}`, {
      headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
    })
    if (res.ok) {
      const data = await res.json()
      const combined = [data.tagline, data.overview].filter(Boolean).join(' — ')
      if (combined.length >= 100) return { text: combined, source: 'tmdb' }
    }
  } catch { /* fall through */ }

  // 3. OMDB plot
  if (film.imdbId && OMDB_API_KEY) {
    try {
      const res = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(film.imdbId)}&plot=full&apikey=${OMDB_API_KEY}`)
      if (res.ok) {
        const data = await res.json()
        if (data.Response === 'True' && data.Plot && data.Plot !== 'N/A' && data.Plot.length >= 100) {
          return { text: data.Plot, source: 'omdb' }
        }
      }
    } catch { /* fall through */ }
  }

  // 4. Stored synopsis
  if (film.synopsis && film.synopsis.length >= 100) {
    return { text: film.synopsis, source: 'tmdb' }
  }

  return { text: '', source: 'reviews_only' }
}

// ── Quality filter ──
const ENGLISH_REGEX = /^[\x00-\x7F\u00C0-\u024F\u2018-\u201D\u2014\u2013\u2026\s.,;:!?'"()\-[\]{}@#$%^&*+=/<>~`|\\]+$/
const MIN_WORD_COUNT = 50

function isQualityReview(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (words.length < MIN_WORD_COUNT) return false
  if (!ENGLISH_REGEX.test(text.slice(0, 500))) return false
  return true
}

// ── Check if beats already contain proper nouns (specific enough) ──
function beatsAlreadySpecific(dataPoints: any[]): boolean {
  if (!dataPoints || dataPoints.length === 0) return false

  // Common proper noun patterns: capitalized words that aren't sentence starters or common adjectives
  const genericLabels = new Set([
    'how does it start?', 'setting the scene', 'meeting the characters',
    'things get interesting', 'the big twist', 'everything changes',
    'the emotional peak', 'building tension', 'final thoughts',
    'how does it end?', 'the payoff', 'opening mystery', 'darker turn',
    'resolution', 'emotional depth', 'emotional payoff',
  ])

  let specificCount = 0
  for (const dp of dataPoints) {
    const label = (dp.label || '').toLowerCase().trim()
    if (genericLabels.has(label)) continue

    // Check for character names / proper nouns: capitalized word not at sentence start that isn't a common word
    const words = (dp.label || '').split(/\s+/)
    const hasProperNoun = words.some((w: string, i: number) => {
      if (i === 0) return false // skip sentence-start capitalization
      if (w.length < 2) return false
      return /^[A-Z][a-z]/.test(w) && !['The', 'And', 'But', 'For', 'With', 'Into', 'From', 'Through'].includes(w)
    })
    if (hasProperNoun) specificCount++
  }

  // If more than half the beats have proper nouns, consider already specific
  return specificCount > dataPoints.length / 2
}

// ── Build prompt ──
function buildPrompt(film: any, reviews: any[], plotContext: PlotContext): string {
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

  const plotSection = plotContext.source !== 'reviews_only'
    ? `\n## Plot Synopsis (source: ${plotContext.source})\n\n${plotContext.text.slice(0, 4000)}\n\nUse this plot summary to generate beat labels that reference specific scenes, character names, and plot moments from this film. CRITICAL: Do NOT conflate emotionally dark or sad plot events with negative audience reception. A scene can be devastating or tragic but still be beloved by audiences. Always score based on reviewer sentiment toward the scene, not the emotional tone of the events themselves.\n`
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
${plotSection}
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
  "sources": ${JSON.stringify([...new Set(reviews.map((r: any) => r.sourcePlatform.toLowerCase()))])},
  "varianceSource": "external_only",
  "reviewCount": ${reviews.length},
  "generatedAt": "${new Date().toISOString()}"
}`
}

// ── Process a single film ──
async function processFilm(film: any): Promise<boolean> {
  const existingGraph = film.sentimentGraph
  const dataPoints = existingGraph?.dataPoints as any[] | null

  // Skip if beats already contain character names / proper nouns
  if (dataPoints && beatsAlreadySpecific(dataPoints)) {
    console.log(`  ⏭ Skipping — beats already contain character names / proper nouns`)
    return false
  }

  // Get quality reviews
  const reviews = film.reviews.filter((r: any) => isQualityReview(r.reviewText))
  if (reviews.length < 1) {
    console.log(`  ⏭ Skipping — no quality reviews`)
    return false
  }

  // Fetch plot context
  const plotContext = await fetchPlotContext(film)
  console.log(`  Plot context: ${plotContext.source} (${plotContext.text.length} chars)`)

  // Generate new beats via Claude
  const prompt = buildPrompt(film, reviews, plotContext)
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('')
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
  const graphData = JSON.parse(cleaned)

  if (!graphData.dataPoints || graphData.dataPoints.length < 10) {
    throw new Error(`Invalid: only ${graphData.dataPoints?.length || 0} data points`)
  }

  // Update the existing sentiment graph with new data points AND scores
  await prisma.sentimentGraph.update({
    where: { filmId: film.id },
    data: {
      previousScore: existingGraph.overallScore,
      overallScore: graphData.overallSentiment,
      dataPoints: graphData.dataPoints,
      peakMoment: graphData.peakMoment,
      lowestMoment: graphData.lowestMoment,
      biggestSwing: graphData.biggestSentimentSwing,
      summary: graphData.summary,
      generatedAt: new Date(),
      version: existingGraph.version + 1,
    },
  })

  console.log(`  ✓ Updated ${film.title} — used ${plotContext.source} (score: ${existingGraph.overallScore} → ${graphData.overallSentiment})`)
  return true
}

// ── Main ──
async function main() {
  console.log('Wikipedia Beat Backfill')
  console.log('Regenerating beats + scores using plot context\n')

  // Fetch all films with sentiment graphs
  const films = await prisma.film.findMany({
    where: { sentimentGraph: { isNot: null } },
    include: {
      sentimentGraph: true,
      reviews: true,
    },
    orderBy: { title: 'asc' },
  })

  // Support --start-after "Film Title" to resume from a specific point
  const startAfterIdx = process.argv.indexOf('--start-after')
  const startAfterTitle = startAfterIdx >= 0 ? process.argv[startAfterIdx + 1] : null

  let filmsToProcess = films
  if (startAfterTitle) {
    const idx = films.findIndex(f => f.title === startAfterTitle)
    if (idx >= 0) {
      filmsToProcess = films.slice(idx + 1)
      console.log(`Resuming after "${startAfterTitle}" — ${filmsToProcess.length} films remaining\n`)
    } else {
      console.log(`Warning: "${startAfterTitle}" not found, processing all films\n`)
    }
  } else {
    console.log(`Found ${films.length} films with sentiment graphs\n`)
  }

  let succeeded = 0, skipped = 0, failed = 0

  // Process in batches of 10
  for (let i = 0; i < filmsToProcess.length; i += 10) {
    const batch = filmsToProcess.slice(i, i + 10)
    console.log(`\n── Batch ${Math.floor(i / 10) + 1} (films ${i + 1}-${Math.min(i + 10, filmsToProcess.length)}) ──`)

    for (const film of batch) {
      console.log(`\n${film.title}:`)
      try {
        const updated = await processFilm(film)
        if (updated) succeeded++
        else skipped++
      } catch (err) {
        console.error(`  ✗ Failed: ${err instanceof Error ? err.message : err}`)
        failed++
      }

      // Pause between API calls
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`Done: ${succeeded} updated, ${skipped} skipped, ${failed} failed`)
  process.exit(0)
}

main()
