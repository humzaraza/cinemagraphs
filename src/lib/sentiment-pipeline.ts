import { prisma } from './prisma'
import { fetchAnchorScores } from './omdb'
import { fetchAllReviews } from './review-fetcher'
import { analyzeSentiment } from './claude'
import type { AnchorScores } from './omdb'

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

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

  console.log(`[Pipeline] Starting analysis for "${film.title}"`)

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

  console.log(`[Pipeline] Anchor scores: IMDb ${anchorScores.imdbRating}, RT ${anchorScores.rtCriticsScore}%, MC ${anchorScores.metacriticScore}`)

  // 4. Fetch reviews from all sources
  const totalFetched = await fetchAllReviews(film)

  // Get all stored reviews for this film
  const reviews = await prisma.review.findMany({
    where: { filmId: film.id },
    orderBy: { fetchedAt: 'desc' },
  })

  if (reviews.length < 3) {
    throw new Error(`Insufficient reviews for "${film.title}": only ${reviews.length} found (minimum 3 required)`)
  }

  console.log(`[Pipeline] ${reviews.length} reviews available for analysis`)

  // 5. Send to Claude API for analysis
  const graphData = await analyzeSentiment(film, reviews, anchorScores)

  // 6. Store result in SentimentGraph table
  const existing = await prisma.sentimentGraph.findUnique({ where: { filmId: film.id } })

  if (existing) {
    await prisma.sentimentGraph.update({
      where: { filmId: film.id },
      data: {
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
    console.log(`[Pipeline] Updated sentiment graph for "${film.title}" (v${existing.version + 1})`)
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
    console.log(`[Pipeline] Created sentiment graph for "${film.title}"`)
  }
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
      console.error(`[Pipeline] Failed for ${filmId}: ${message}`)
      failed.push({ id: filmId, error: message })
    }

    // Brief pause between films to avoid rate limits
    if (filmIds.indexOf(filmId) < filmIds.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }

  console.log(`[Pipeline] Batch complete: ${succeeded.length} succeeded, ${failed.length} failed`)
  return { succeeded, failed }
}
