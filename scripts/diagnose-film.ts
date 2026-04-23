/**
 * Diagnostic script: run sentiment pipeline for a single film and log everything.
 * Usage: npx tsx scripts/diagnose-film.ts <filmId>
 *
 * Requires `ws` dev dependency for local Neon DB connection.
 */
import './_load-env'
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket
import { prisma } from '../src/lib/prisma'
import { fetchAnchorScores } from '../src/lib/omdb'
import { fetchAllReviews } from '../src/lib/review-fetcher'
import { fetchPlotContext, generateSentimentGraph } from '../src/lib/sentiment-pipeline'

const FILM_ID = process.argv[2]
if (!FILM_ID) {
  console.error('Usage: npx tsx scripts/diagnose-film.ts <filmId>')
  process.exit(1)
}

const ENGLISH_REGEX = /^[\x00-\x7F\u00C0-\u024F\u2018-\u201D\u2014\u2013\u2026\s.,;:!?'"()\-[\]{}@#$%^&*+=/<>~`|\\]+$/
const MIN_WORD_COUNT = 50
function isQualityReview(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (words.length < MIN_WORD_COUNT) return false
  if (!ENGLISH_REGEX.test(text.slice(0, 500))) return false
  return true
}

async function main() {
  console.log('=== DIAGNOSE SENTIMENT PIPELINE ===')
  console.log(`Film ID: ${FILM_ID}\n`)

  // Step 1: Lookup film
  const film = await prisma.film.findUnique({ where: { id: FILM_ID } })
  if (!film) {
    console.error('Film not found in database')
    process.exit(1)
  }
  console.log(`Film: ${film.title} (${film.releaseDate?.getFullYear() ?? 'N/A'})`)
  console.log(`   TMDB ID: ${film.tmdbId}`)
  console.log(`   IMDb ID: ${film.imdbId ?? 'MISSING'}`)
  console.log(`   Runtime: ${film.runtime ?? 'N/A'} min`)
  console.log(`   Existing scores: IMDb=${film.imdbRating}, RT Critics=${film.rtCriticsScore}, RT Audience=${film.rtAudienceScore}, Metacritic=${film.metacriticScore}`)
  console.log()

  // Step 2: Check existing graph
  const existingGraph = await prisma.sentimentGraph.findUnique({ where: { filmId: FILM_ID } })
  if (existingGraph) {
    console.log(`Existing graph: score=${existingGraph.overallScore}, reviewCount=${existingGraph.reviewCount}, version=${existingGraph.version}`)
  } else {
    console.log('No existing sentiment graph')
  }
  console.log()

  // Step 3: Anchor scores
  console.log('--- ANCHOR SCORES ---')
  if (film.imdbId) {
    try {
      const scores = await fetchAnchorScores(film.imdbId)
      console.log(`OMDB anchor scores:`, JSON.stringify(scores, null, 2))
    } catch (err) {
      console.error(`OMDB fetch failed:`, err instanceof Error ? err.message : err)
    }
  } else {
    console.log('No IMDb ID — skipping OMDB anchor scores')
  }
  console.log()

  // Step 4: Fetch reviews
  console.log('--- FETCHING REVIEWS ---')
  try {
    const totalFetched = await fetchAllReviews(film)
    console.log(`\nTotal fetched from sources: ${totalFetched}`)
  } catch (err) {
    console.error(`Review fetching failed:`, err instanceof Error ? err.message : err)
  }
  console.log()

  // Step 5: Review quality check
  console.log('--- REVIEW QUALITY CHECK ---')
  const allReviews = await prisma.review.findMany({
    where: { filmId: FILM_ID },
    orderBy: { fetchedAt: 'desc' },
  })
  console.log(`Total reviews in DB: ${allReviews.length}`)

  const qualityReviews = allReviews.filter((r) => isQualityReview(r.reviewText))
  console.log(`Quality reviews (>=${MIN_WORD_COUNT} words, English): ${qualityReviews.length}`)

  // Per-source breakdown of quality reviews
  const sourceBreakdown: Record<string, { total: number; quality: number }> = {}
  for (const r of allReviews) {
    const src = r.sourcePlatform
    if (!sourceBreakdown[src]) sourceBreakdown[src] = { total: 0, quality: 0 }
    sourceBreakdown[src].total++
    if (isQualityReview(r.reviewText)) sourceBreakdown[src].quality++
  }
  console.log('\nPer-source breakdown:')
  for (const [src, counts] of Object.entries(sourceBreakdown)) {
    console.log(`  ${src}: ${counts.quality} quality / ${counts.total} total`)
  }

  // Rejection samples
  const rejected = allReviews.filter((r) => !isQualityReview(r.reviewText))
  if (rejected.length > 0) {
    console.log(`\nSample rejected reviews (first 3):`)
    for (const r of rejected.slice(0, 3)) {
      const words = r.reviewText.trim().split(/\s+/).length
      const isEnglish = ENGLISH_REGEX.test(r.reviewText.slice(0, 500))
      console.log(`  [${r.sourcePlatform}] ${words} words, english=${isEnglish}: "${r.reviewText.slice(0, 80)}..."`)
    }
  }

  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
  const isRecent = film.releaseDate && film.releaseDate > sixMonthsAgo
  const minReviews = isRecent ? 1 : 2
  console.log(`\nMinimum required: ${minReviews} (recent release: ${!!isRecent})`)
  if (qualityReviews.length < minReviews) {
    console.error(`\nINSUFFICIENT QUALITY REVIEWS: ${qualityReviews.length} < ${minReviews}`)
    console.log('The pipeline would throw here — not enough quality reviews.')
  } else {
    console.log(`Meets minimum threshold (${qualityReviews.length} >= ${minReviews})`)
  }
  console.log()

  // Step 6: Plot context
  console.log('--- PLOT CONTEXT ---')
  try {
    const plot = await fetchPlotContext(film)
    console.log(`Source: ${plot.source}`)
    console.log(`Length: ${plot.text.length} chars`)
    if (plot.text) console.log(`Preview: "${plot.text.slice(0, 150)}..."`)
  } catch (err) {
    console.error(`Plot context failed:`, err instanceof Error ? err.message : err)
  }
  console.log()

  // Step 7: Attempt full generation?
  const runFull = process.argv.includes('--generate')
  if (qualityReviews.length >= minReviews && runFull) {
    console.log('--- FULL PIPELINE RUN ---')
    console.log('Attempting generateSentimentGraph()...\n')
    try {
      await generateSentimentGraph(FILM_ID, { callerPath: 'script-diagnose-film' })
      console.log('\nSentiment graph generated successfully!')
    } catch (err) {
      console.error(`\nPipeline failed:`, err instanceof Error ? err.message : err)
      if (err instanceof Error && err.stack) {
        console.error('Stack:', err.stack.split('\n').slice(1, 5).join('\n'))
      }
    }
  } else if (!runFull) {
    console.log('Add --generate flag to run the full pipeline (sends to Claude API)')
  } else {
    console.log('Skipping full pipeline run (insufficient reviews)')
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
