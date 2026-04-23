import './_load-env'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import { forceOverwriteSentimentGraph } from '../src/lib/sentiment-beat-lock'

async function main() {
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({ adapter })

  // Find Oppenheimer
  const film = await prisma.film.findFirst({ where: { title: { contains: 'Oppenheimer' } } })
  if (!film) {
    console.error('Oppenheimer not found in database')
    process.exit(1)
  }

  console.log(`Found: ${film.title} (ID: ${film.id}, IMDb ID: ${film.imdbId})`)

  // Import the pipeline dynamically to use our prisma instance
  // We'll inline the pipeline steps here instead

  // Step 1: OMDB scores
  const OMDB_API_KEY = process.env.OMDB_API_KEY
  let anchorScores = {
    imdbRating: film.imdbRating,
    rtCriticsScore: film.rtCriticsScore,
    rtAudienceScore: film.rtAudienceScore,
    metacriticScore: film.metacriticScore,
  }

  if (film.imdbId && OMDB_API_KEY) {
    console.log('\n--- Fetching OMDB scores ---')
    const omdbRes = await fetch(`https://www.omdbapi.com/?i=${film.imdbId}&apikey=${OMDB_API_KEY}`)
    const omdbData = await omdbRes.json()
    console.log('OMDB response:', JSON.stringify(omdbData, null, 2).slice(0, 500))

    if (omdbData.Response === 'True') {
      anchorScores.imdbRating = omdbData.imdbRating !== 'N/A' ? parseFloat(omdbData.imdbRating) : null
      const rt = omdbData.Ratings?.find((r: any) => r.Source === 'Rotten Tomatoes')
      if (rt) anchorScores.rtCriticsScore = parseInt(rt.Value.replace('%', ''), 10)
      if (omdbData.Metascore !== 'N/A') anchorScores.metacriticScore = parseInt(omdbData.Metascore, 10)

      // Update film
      await prisma.film.update({
        where: { id: film.id },
        data: {
          imdbRating: anchorScores.imdbRating,
          rtCriticsScore: anchorScores.rtCriticsScore,
          metacriticScore: anchorScores.metacriticScore,
        },
      })
    }
  }
  console.log('Anchor scores:', anchorScores)

  // Step 2: Fetch TMDB reviews
  console.log('\n--- Fetching TMDB reviews ---')
  const TMDB_API_KEY = process.env.TMDB_API_KEY!
  const tmdbRes = await fetch(`https://api.themoviedb.org/3/movie/${film.tmdbId}/reviews?page=1`, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
  })
  const tmdbData = await tmdbRes.json()
  console.log(`TMDB reviews: ${tmdbData.results?.length || 0}`)

  // Step 3: Fetch IMDb reviews via RapidAPI
  console.log('\n--- Fetching IMDb reviews ---')
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY
  const RAPIDAPI_HOST = process.env.RAPIDAPI_IMDB_HOST || 'imdb236.p.rapidapi.com'
  let imdbReviews: any[] = []
  if (RAPIDAPI_KEY && film.imdbId) {
    try {
      const imdbRes = await fetch(
        `https://${RAPIDAPI_HOST}/imdb/user-reviews?id=${film.imdbId}`,
        {
          headers: {
            'x-rapidapi-key': RAPIDAPI_KEY,
            'x-rapidapi-host': RAPIDAPI_HOST,
          },
        }
      )
      if (imdbRes.ok) {
        const imdbData = await imdbRes.json()
        console.log('IMDb response keys:', Object.keys(imdbData))
        console.log('IMDb response sample:', JSON.stringify(imdbData).slice(0, 500))
        imdbReviews = Array.isArray(imdbData) ? imdbData : (imdbData.reviews || imdbData.results || [])
      } else {
        console.log(`IMDb API error: ${imdbRes.status}`)
      }
    } catch (err) {
      console.log('IMDb fetch error:', err)
    }
  }
  console.log(`IMDb reviews: ${imdbReviews.length}`)

  // Collect all reviews
  const allReviews: { sourcePlatform: string; author: string | null; reviewText: string; sourceRating: number | null }[] = []

  for (const r of (tmdbData.results || [])) {
    if (r.content && r.content.length > 50) {
      allReviews.push({
        sourcePlatform: 'TMDB',
        author: r.author || null,
        reviewText: r.content.slice(0, 1500),
        sourceRating: r.author_details?.rating ? r.author_details.rating / 2 : null,
      })
    }
  }

  for (const r of imdbReviews.slice(0, 15)) {
    const text = r.review || r.content || r.reviewText || r.text || ''
    if (text.length > 50) {
      allReviews.push({
        sourcePlatform: 'IMDB',
        author: r.author || r.username || null,
        reviewText: text.slice(0, 1500),
        sourceRating: r.rating ? parseFloat(r.rating) : null,
      })
    }
  }

  console.log(`\nTotal reviews collected: ${allReviews.length}`)

  if (allReviews.length < 3) {
    console.error('Not enough reviews for analysis (minimum 3)')
    process.exit(1)
  }

  // Step 4: Claude analysis
  console.log('\n--- Running Claude analysis ---')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1) }
  const anthropic = new Anthropic({ apiKey })

  const runtime = film.runtime || 180
  const segmentCount = Math.min(Math.max(14, Math.round(runtime / 8)), 18)
  const anchors: string[] = []
  if (anchorScores.imdbRating) anchors.push(`IMDb ${anchorScores.imdbRating}`)
  if (anchorScores.rtCriticsScore) anchors.push(`RT ${anchorScores.rtCriticsScore}%`)
  if (anchorScores.metacriticScore) anchors.push(`MC ${anchorScores.metacriticScore}`)
  const anchorString = anchors.join(' | ')
  const targetScore = anchorScores.imdbRating || 7.0

  const reviewBlock = allReviews
    .slice(0, 40)
    .map((r, i) => `[Review ${i + 1} — ${r.sourcePlatform}${r.sourceRating ? ` (${r.sourceRating}/10)` : ''}]\n${r.reviewText}`)
    .join('\n\n---\n\n')

  const prompt = `You are a film sentiment analyst. Analyze the following reviews for "${film.title}" and generate a sentiment graph showing how audience opinion shifts across the film's ${runtime}-minute runtime.

## Film Information
- Title: ${film.title}
- Director: ${film.director || 'Unknown'}
- Runtime: ${runtime} minutes
- Genres: ${film.genres?.join(', ') || 'Unknown'}

## Aggregate Scores (ANCHOR — your overall must be within ±0.2 of the IMDb score)
${anchorString}
Target overall sentiment: ${targetScore} (±0.2 variance allowed)

## Instructions
1. Generate exactly ${segmentCount} data points spanning 0 to ${runtime} minutes.
2. Score on 1-10 scale. USE THE FULL SCALE.
3. Overall average must be within ±0.2 of ${targetScore}.
4. Use CONVERSATIONAL labels (not screenwriting jargon).
5. Return ONLY valid JSON (no markdown fences).

## Reviews
${reviewBlock}

## Required JSON format
{
  "film": "${film.title}",
  "anchoredFrom": "${anchorString}",
  "dataPoints": [{"timeStart": 0, "timeEnd": 11, "timeMidpoint": 5, "score": 7.5, "label": "Setting the scene", "confidence": "medium", "reviewEvidence": "..."}],
  "overallSentiment": ${targetScore},
  "peakMoment": {"label": "...", "score": 9.0, "time": 95},
  "lowestMoment": {"label": "...", "score": 6.0, "time": 45},
  "biggestSentimentSwing": "...",
  "summary": "...",
  "sources": ${JSON.stringify([...new Set(allReviews.map(r => r.sourcePlatform.toLowerCase()))])},
  "varianceSource": "external_only",
  "reviewCount": ${allReviews.length},
  "generatedAt": "${new Date().toISOString()}"
}`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  })

  const responseText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

  const cleaned = responseText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
  const graphData = JSON.parse(cleaned)

  console.log(`Data points: ${graphData.dataPoints?.length}`)
  console.log(`Overall sentiment: ${graphData.overallSentiment}`)
  console.log(`Peak: ${graphData.peakMoment?.label} (${graphData.peakMoment?.score})`)
  console.log(`Low: ${graphData.lowestMoment?.label} (${graphData.lowestMoment?.score})`)
  console.log(`Summary: ${graphData.summary}`)

  // Step 5: Store in database
  console.log('\n--- Storing sentiment graph ---')

  // Store reviews first
  const { createHash } = await import('crypto')
  for (const review of allReviews) {
    const hash = createHash('sha256').update(review.reviewText.trim().toLowerCase()).digest('hex')
    const existing = await prisma.review.findFirst({ where: { contentHash: hash, filmId: film.id } })
    if (!existing) {
      await prisma.review.create({
        data: {
          filmId: film.id,
          sourcePlatform: review.sourcePlatform as any,
          reviewText: review.reviewText,
          author: review.author,
          sourceRating: review.sourceRating,
          contentHash: hash,
        },
      })
    }
  }

  // Store graph via force-overwrite — pipeline smoke test intentionally
  // rewrites labels + timestamps without merging against existing beats.
  const existingGraph = await prisma.sentimentGraph.findUnique({ where: { filmId: film.id } })
  await forceOverwriteSentimentGraph({
    filmId: film.id,
    dataPoints: graphData.dataPoints,
    otherFields: {
      overallScore: graphData.overallSentiment,
      anchoredFrom: graphData.anchoredFrom,
      peakMoment: graphData.peakMoment,
      lowestMoment: graphData.lowestMoment,
      biggestSwing: graphData.biggestSentimentSwing,
      summary: graphData.summary,
      reviewCount: graphData.reviewCount,
      sourcesUsed: graphData.sources,
      generatedAt: new Date(),
      ...(existingGraph ? { version: existingGraph.version + 1 } : {}),
    },
    callerPath: 'script-test-pipeline',
  })

  console.log('\n✓ Pipeline test complete! Sentiment graph stored for Oppenheimer.')
  process.exit(0)
}

main().catch(err => {
  console.error('Pipeline test failed:', err)
  process.exit(1)
})
