import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import { isQualityReview } from '../src/lib/sentiment-pipeline'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const OMDB_API_KEY = process.env.OMDB_API_KEY!
const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY
if (!apiKey) { console.error('No Anthropic API key found'); process.exit(1) }
const anthropic = new Anthropic({ apiKey })

async function fetchOMDB(imdbId: string) {
  const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`)
  const data = await res.json()
  if (data.Response !== 'True') return null

  const rt = data.Ratings?.find((r: any) => r.Source === 'Rotten Tomatoes')
  return {
    imdbRating: data.imdbRating !== 'N/A' ? parseFloat(data.imdbRating) : null,
    rtCriticsScore: rt ? parseInt(rt.Value.replace('%', ''), 10) : null,
    metacriticScore: data.Metascore !== 'N/A' ? parseInt(data.Metascore, 10) : null,
  }
}

function needsReanalysis(film: any, filteredReviewCount: number): { needs: boolean; reason: string } {
  // No graph yet — always analyze
  if (!film._hasGraph) return { needs: true, reason: 'No existing graph' }

  const lastCount = film.lastReviewCount || 0
  if (lastCount === 0) {
    return { needs: filteredReviewCount >= 3, reason: 'Legacy film, no lastReviewCount' }
  }

  const threshold = Math.max(1, Math.ceil(lastCount * 0.10))
  const newReviews = filteredReviewCount - lastCount
  if (newReviews >= threshold) {
    return { needs: true, reason: `${newReviews} new quality reviews (threshold: ${threshold})` }
  }
  return { needs: false, reason: `Only ${newReviews} new reviews (need ${threshold})` }
}

async function fetchTMDBReviews(tmdbId: number) {
  const reviews: any[] = []
  for (let page = 1; page <= 2; page++) {
    const res = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/reviews?page=${page}`, {
      headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
    })
    if (!res.ok) break
    const data = await res.json()
    reviews.push(...(data.results || []))
    if (page >= data.total_pages) break
  }
  return reviews.filter((r: any) => r.content && r.content.length > 50)
}

async function analyzeFilm(film: any) {
  console.log(`\n=== ${film.title} ===`)

  // Fetch OMDB scores
  let anchorScores = { imdbRating: film.imdbRating, rtCriticsScore: film.rtCriticsScore, metacriticScore: film.metacriticScore }
  if (film.imdbId) {
    const omdb = await fetchOMDB(film.imdbId)
    if (omdb) {
      anchorScores = { ...anchorScores, ...omdb }
      await prisma.film.update({
        where: { id: film.id },
        data: { imdbRating: omdb.imdbRating, rtCriticsScore: omdb.rtCriticsScore, metacriticScore: omdb.metacriticScore },
      })
    }
  }

  // Fetch reviews
  const tmdbReviews = await fetchTMDBReviews(film.tmdbId)
  console.log(`  Reviews: ${tmdbReviews.length} from TMDB`)

  const allReviews = tmdbReviews.map((r: any) => ({
    sourcePlatform: 'TMDB',
    author: r.author || null,
    reviewText: r.content.slice(0, 1500),
    sourceRating: r.author_details?.rating ? r.author_details.rating / 2 : null,
  }))

  // Filter for quality: ≥50 words + English
  const reviews = allReviews.filter((r: any) => isQualityReview(r.reviewText))
  const filteredCount = reviews.length
  console.log(`  Quality reviews: ${filteredCount}/${allReviews.length}`)

  if (reviews.length < 3) {
    console.log(`  ⚠ Only ${reviews.length} quality reviews — skipping`)
    return false
  }

  // Check re-analysis threshold
  const { needs, reason } = needsReanalysis(film, filteredCount)
  if (!needs) {
    console.log(`  ⏭ Skipping: ${reason}`)
    return false
  }
  console.log(`  → Analyzing: ${reason}`)

  // Store reviews
  for (const review of reviews) {
    const hash = createHash('sha256').update(review.reviewText.trim().toLowerCase()).digest('hex')
    const existing = await prisma.review.findFirst({ where: { contentHash: hash, filmId: film.id } })
    if (!existing) {
      await prisma.review.create({
        data: { filmId: film.id, sourcePlatform: review.sourcePlatform as any, reviewText: review.reviewText, author: review.author, sourceRating: review.sourceRating, contentHash: hash },
      })
    }
  }

  // Claude analysis
  const runtime = film.runtime || 120
  const segmentCount = Math.min(Math.max(14, Math.round(runtime / 8)), 18)
  const anchors: string[] = []
  if (anchorScores.imdbRating) anchors.push(`IMDb ${anchorScores.imdbRating}`)
  if (anchorScores.rtCriticsScore) anchors.push(`RT ${anchorScores.rtCriticsScore}%`)
  if (anchorScores.metacriticScore) anchors.push(`MC ${anchorScores.metacriticScore}`)
  const anchorString = anchors.join(' | ')
  const targetScore = anchorScores.imdbRating || 7.0

  const reviewBlock = reviews.slice(0, 30).map((r: any, i: number) =>
    `[Review ${i + 1} — ${r.sourcePlatform}${r.sourceRating ? ` (${r.sourceRating}/10)` : ''}]\n${r.reviewText}`
  ).join('\n\n---\n\n')

  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : ''

  const prompt = `You are a film sentiment analyst. Analyze reviews for "${film.title}" (${year}) and generate a sentiment graph across the ${runtime}-minute runtime.

Film: ${film.title} | Director: ${film.director || 'Unknown'} | Runtime: ${runtime}min | Genres: ${film.genres?.join(', ') || 'Unknown'}

Anchor scores: ${anchorString}
Target overall: ${targetScore} (±0.2)

Rules:
1. Generate exactly ${segmentCount} data points spanning 0-${runtime} minutes
2. Score 1-10 scale, USE FULL RANGE
3. Overall average within ±0.2 of ${targetScore}
4. Conversational labels (NO screenwriting jargon)
5. Return ONLY valid JSON, no markdown

Reviews:
${reviewBlock}

Return this JSON structure:
{"film":"${film.title}","anchoredFrom":"${anchorString}","dataPoints":[{"timeStart":0,"timeEnd":0,"timeMidpoint":0,"score":0,"label":"","confidence":"medium","reviewEvidence":""}],"overallSentiment":${targetScore},"peakMoment":{"label":"","score":0,"time":0},"lowestMoment":{"label":"","score":0,"time":0},"biggestSentimentSwing":"","summary":"","sources":["tmdb"],"varianceSource":"external_only","reviewCount":${reviews.length},"generatedAt":"${new Date().toISOString()}"}`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('')
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
  const graphData = JSON.parse(cleaned)

  // Store graph
  const existing = await prisma.sentimentGraph.findUnique({ where: { filmId: film.id } })
  const graphPayload = {
    overallScore: graphData.overallSentiment,
    anchoredFrom: graphData.anchoredFrom,
    dataPoints: graphData.dataPoints,
    peakMoment: graphData.peakMoment,
    lowestMoment: graphData.lowestMoment,
    biggestSwing: graphData.biggestSentimentSwing,
    summary: graphData.summary,
    reviewCount: graphData.reviewCount,
    sourcesUsed: graphData.sources,
    generatedAt: new Date(),
  }

  if (existing) {
    await prisma.sentimentGraph.update({ where: { filmId: film.id }, data: { ...graphPayload, version: existing.version + 1 } })
  } else {
    await prisma.sentimentGraph.create({ data: { filmId: film.id, ...graphPayload } })
  }

  // Update lastReviewCount so future re-analysis checks the delta
  await prisma.film.update({
    where: { id: film.id },
    data: { lastReviewCount: filteredCount },
  })

  console.log(`  ✓ Score: ${graphData.overallSentiment} | Peak: ${graphData.peakMoment?.label} (${graphData.peakMoment?.score}) | Low: ${graphData.lowestMoment?.label} (${graphData.lowestMoment?.score})`)
  return true
}

async function main() {
  const films = await prisma.film.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { title: 'asc' },
  })

  // Mark which films already have graphs
  const filmsWithGraphs = await prisma.sentimentGraph.findMany({ select: { filmId: true } })
  const graphFilmIds = new Set(filmsWithGraphs.map(g => g.filmId))
  const filmsToProcess = films.map(f => ({ ...f, _hasGraph: graphFilmIds.has(f.id) }))

  const withGraphs = filmsToProcess.filter(f => f._hasGraph).length
  const withoutGraphs = filmsToProcess.length - withGraphs
  console.log(`Total: ${filmsToProcess.length} films (${withGraphs} with graphs, ${withoutGraphs} without)`)
  console.log(`Re-analysis uses 10% review growth threshold\n`)

  let succeeded = 0, failed = 0, skipped = 0

  for (const film of filmsToProcess) {
    try {
      const ok = await analyzeFilm(film)
      if (ok) succeeded++
      else skipped++
      // Brief pause between API calls
      await new Promise(resolve => setTimeout(resolve, 2000))
    } catch (err) {
      console.error(`  ✗ ${film.title}: ${err instanceof Error ? err.message : err}`)
      failed++
    }
  }

  console.log(`\n=== Done: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped ===`)
  process.exit(0)
}

main()
