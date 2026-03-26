import { prisma } from './prisma'
import { fetchAnchorScores } from './omdb'
import { fetchAllReviews } from './review-fetcher'
import { analyzeSentiment } from './claude'
import type { AnchorScores } from './omdb'
import { pipelineLogger } from './logger'

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

// ── Review quality filter ──

const ENGLISH_REGEX = /^[\x00-\x7F\u00C0-\u024F\u2018-\u201D\u2014\u2013\u2026\s.,;:!?'"()\-[\]{}@#$%^&*+=/<>~`|\\]+$/
const MIN_WORD_COUNT = 50

function isQualityReview(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (words.length < MIN_WORD_COUNT) return false
  // Check if predominantly English/Latin characters
  if (!ENGLISH_REGEX.test(text.slice(0, 500))) return false
  return true
}

/**
 * Check if a film needs re-analysis based on review growth threshold.
 * Returns true if:
 * - No existing graph (never analyzed)
 * - Filtered review count grew by ≥10% over lastReviewCount
 */
export async function filmNeedsReanalysis(filmId: string): Promise<{ needsAnalysis: boolean; filteredCount: number; reason: string }> {
  const film = await prisma.film.findUnique({
    where: { id: filmId },
    include: { sentimentGraph: { select: { id: true } } },
  })
  if (!film) return { needsAnalysis: false, filteredCount: 0, reason: 'Film not found' }

  // Never analyzed — always analyze
  if (!film.sentimentGraph) {
    return { needsAnalysis: true, filteredCount: 0, reason: 'No existing graph' }
  }

  // Count filtered reviews
  const reviews = await prisma.review.findMany({
    where: { filmId },
    select: { reviewText: true },
  })
  const filteredCount = reviews.filter((r) => isQualityReview(r.reviewText)).length

  const lastCount = film.lastReviewCount || 0
  if (lastCount === 0) {
    // Had a graph but lastReviewCount wasn't set (legacy) — re-analyze if ≥3 quality reviews
    return {
      needsAnalysis: filteredCount >= 3,
      filteredCount,
      reason: lastCount === 0 ? 'Legacy film, no lastReviewCount' : 'No previous reviews',
    }
  }

  const threshold = Math.max(1, Math.ceil(lastCount * 0.10))
  const newReviews = filteredCount - lastCount

  if (newReviews >= threshold) {
    return {
      needsAnalysis: true,
      filteredCount,
      reason: `${newReviews} new quality reviews (threshold: ${threshold})`,
    }
  }

  return {
    needsAnalysis: false,
    filteredCount,
    reason: `Only ${newReviews} new reviews (need ${threshold})`,
  }
}

async function lookupImdbId(tmdbId: number): Promise<string | null> {
  try {
    const res = await fetch(`${TMDB_BASE_URL}/movie/${tmdbId}/external_ids`, {
      headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.imdb_id || null
  } catch {
    return null
  }
}

export async function generateSentimentGraph(filmId: string): Promise<void> {
  // 1. Get film from database
  const film = await prisma.film.findUnique({ where: { id: filmId } })
  if (!film) throw new Error(`Film not found: ${filmId}`)

  pipelineLogger.info({ filmId: film.id, filmTitle: film.title }, 'Starting analysis')

  // 2. Ensure we have the IMDb ID
  if (!film.imdbId) {
    const imdbId = await lookupImdbId(film.tmdbId)
    if (imdbId) {
      await prisma.film.update({
        where: { id: filmId },
        data: { imdbId },
      })
      film.imdbId = imdbId
    }
  }

  // 3. Fetch anchor scores from OMDB
  let anchorScores: AnchorScores = {
    imdbRating: film.imdbRating,
    rtCriticsScore: film.rtCriticsScore,
    rtAudienceScore: film.rtAudienceScore,
    metacriticScore: film.metacriticScore,
  }

  if (film.imdbId) {
    const omdbScores = await fetchAnchorScores(film.imdbId)
    // Update film with any new scores
    const updates: Record<string, number | null> = {}
    if (omdbScores.imdbRating && !film.imdbRating) updates.imdbRating = omdbScores.imdbRating
    if (omdbScores.rtCriticsScore) updates.rtCriticsScore = omdbScores.rtCriticsScore
    if (omdbScores.rtAudienceScore) updates.rtAudienceScore = omdbScores.rtAudienceScore
    if (omdbScores.metacriticScore) updates.metacriticScore = omdbScores.metacriticScore

    if (Object.keys(updates).length > 0) {
      await prisma.film.update({ where: { id: filmId }, data: updates })
    }

    anchorScores = {
      imdbRating: omdbScores.imdbRating || film.imdbRating,
      rtCriticsScore: omdbScores.rtCriticsScore || film.rtCriticsScore,
      rtAudienceScore: omdbScores.rtAudienceScore || film.rtAudienceScore,
      metacriticScore: omdbScores.metacriticScore || film.metacriticScore,
    }
  }

  pipelineLogger.info({ filmId: film.id, filmTitle: film.title, imdbRating: anchorScores.imdbRating, rtCriticsScore: anchorScores.rtCriticsScore, metacriticScore: anchorScores.metacriticScore }, 'Anchor scores fetched')

  // 4. Fetch reviews from all sources
  const totalFetched = await fetchAllReviews(film)

  // Get all stored reviews for this film, filter for quality
  const allReviews = await prisma.review.findMany({
    where: { filmId: film.id },
    orderBy: { fetchedAt: 'desc' },
  })
  const reviews = allReviews.filter((r) => isQualityReview(r.reviewText))
  const filteredReviewCount = reviews.length

  // Lower threshold for newer films (released within last 6 months)
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
  const isRecentRelease = film.releaseDate && film.releaseDate > sixMonthsAgo
  const minReviews = isRecentRelease ? 1 : 2

  if (reviews.length < minReviews) {
    throw new Error(`Insufficient quality reviews for "${film.title}": only ${reviews.length} found (minimum ${minReviews} required)`)
  }

  pipelineLogger.info({ filmId: film.id, filmTitle: film.title, totalReviews: allReviews.length, qualityReviews: filteredReviewCount }, 'Reviews available for analysis')

  // 5. Send to Claude API for analysis
  const graphData = await analyzeSentiment(film, reviews, anchorScores)

  // 6. Store result in SentimentGraph table
  const existing = await prisma.sentimentGraph.findUnique({ where: { filmId: film.id } })

  if (existing) {
    await prisma.sentimentGraph.update({
      where: { filmId: film.id },
      data: {
        previousScore: existing.overallScore,
        overallScore: graphData.overallSentiment,
        anchoredFrom: graphData.anchoredFrom,
        dataPoints: graphData.dataPoints as any,
        peakMoment: graphData.peakMoment as any,
        lowestMoment: graphData.lowestMoment as any,
        biggestSwing: graphData.biggestSentimentSwing,
        summary: graphData.summary,
        reviewCount: graphData.reviewCount,
        sourcesUsed: graphData.sources,
        generatedAt: new Date(),
        version: existing.version + 1,
      },
    })
    pipelineLogger.info({ filmId: film.id, filmTitle: film.title, version: existing.version + 1 }, 'Updated sentiment graph')
  } else {
    await prisma.sentimentGraph.create({
      data: {
        filmId: film.id,
        overallScore: graphData.overallSentiment,
        anchoredFrom: graphData.anchoredFrom,
        dataPoints: graphData.dataPoints as any,
        peakMoment: graphData.peakMoment as any,
        lowestMoment: graphData.lowestMoment as any,
        biggestSwing: graphData.biggestSentimentSwing,
        summary: graphData.summary,
        reviewCount: graphData.reviewCount,
        sourcesUsed: graphData.sources,
        generatedAt: new Date(),
      },
    })
    pipelineLogger.info({ filmId: film.id, filmTitle: film.title }, 'Created sentiment graph')
  }

  // Update lastReviewCount so future re-analysis checks the delta
  await prisma.film.update({
    where: { id: film.id },
    data: { lastReviewCount: filteredReviewCount },
  })
}

export async function generateBatchSentimentGraphs(filmIds: string[]): Promise<{
  succeeded: string[]
  failed: { id: string; error: string }[]
}> {
  const succeeded: string[] = []
  const failed: { id: string; error: string }[] = []

  for (const filmId of filmIds) {
    try {
      await generateSentimentGraph(filmId)
      succeeded.push(filmId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      pipelineLogger.error({ filmId, error: message }, 'Film analysis failed')
      failed.push({ id: filmId, error: message })
    }

    // Brief pause between films to avoid rate limits
    if (filmIds.indexOf(filmId) < filmIds.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }

  pipelineLogger.info({ succeeded: succeeded.length, failed: failed.length }, 'Batch complete')
  return { succeeded, failed }
}
