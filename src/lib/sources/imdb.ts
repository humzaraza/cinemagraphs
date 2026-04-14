import type { Film } from '@/generated/prisma/client'
import type { FetchResult, FetchedReview } from '@/lib/types'
import { reviewLogger } from '@/lib/logger'

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY
const RAPIDAPI_IMDB_HOST = process.env.RAPIDAPI_IMDB_HOST || 'imdb232.p.rapidapi.com'

export async function fetchIMDbReviews(film: Film): Promise<FetchResult> {
  if (!RAPIDAPI_KEY) {
    return { reviews: [], ok: false, reason: 'no RAPIDAPI_KEY' }
  }
  if (!film.imdbId) {
    return { reviews: [], ok: false, reason: 'film missing imdbId' }
  }

  try {
    const reviews: FetchedReview[] = []

    // imdb232 API: /api/title/get-user-reviews with param "tt"
    const userRes = await fetch(
      `https://${RAPIDAPI_IMDB_HOST}/api/title/get-user-reviews?tt=${film.imdbId}&sortBy=HELPFULNESS_SCORE&spoiler=EXCLUDE`,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': RAPIDAPI_IMDB_HOST,
        },
        signal: AbortSignal.timeout(10000),
      }
    )

    // Explicit handling for the two common failure modes we've observed in
    // prod: 403 = plan not subscribed, 429 = monthly quota exhausted. Both
    // used to silently return an empty array; now they return a structured
    // failure with a warn-level log.
    if (userRes.status === 403) {
      reviewLogger.warn(
        { source: 'IMDB', host: RAPIDAPI_IMDB_HOST, imdbId: film.imdbId, filmTitle: film.title },
        'IMDb RapidAPI: subscription required (HTTP 403)'
      )
      return { reviews: [], ok: false, reason: '403 not subscribed' }
    }
    if (userRes.status === 429) {
      reviewLogger.warn(
        { source: 'IMDB', host: RAPIDAPI_IMDB_HOST, imdbId: film.imdbId, filmTitle: film.title },
        'IMDb RapidAPI: quota exceeded (HTTP 429)'
      )
      return { reviews: [], ok: false, reason: '429 quota exceeded' }
    }
    if (!userRes.ok) {
      reviewLogger.warn(
        { source: 'IMDB', host: RAPIDAPI_IMDB_HOST, imdbId: film.imdbId, filmTitle: film.title, status: userRes.status },
        `IMDb RapidAPI: user reviews request failed (HTTP ${userRes.status})`
      )
      return { reviews: [], ok: false, reason: `HTTP ${userRes.status}` }
    }

    const data = await userRes.json()
    const edges = data?.data?.title?.reviews?.edges || []
    for (const edge of edges.slice(0, 15)) {
      const node = edge.node
      if (!node) continue
      const text = node.text?.originalText?.plainText || ''
      if (text.length > 50) {
        reviews.push({
          sourcePlatform: 'IMDB',
          sourceUrl: `https://www.imdb.com/review/${node.id}/`,
          author: node.author?.nickName || null,
          reviewText: text,
          sourceRating: node.authorRating ? node.authorRating : null,
        })
      }
    }

    // Critic reviews are a bonus — if this fails we still report the IMDb
    // source as ok (because user reviews already succeeded), but we do log
    // the failure so quota/block issues don't silently slip by.
    try {
      const criticRes = await fetch(
        `https://${RAPIDAPI_IMDB_HOST}/api/title/get-critic-reviews?tt=${film.imdbId}`,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-rapidapi-key': RAPIDAPI_KEY,
            'x-rapidapi-host': RAPIDAPI_IMDB_HOST,
          },
          signal: AbortSignal.timeout(10000),
        }
      )

      if (criticRes.status === 429) {
        reviewLogger.warn(
          { source: 'IMDB', endpoint: 'critic', imdbId: film.imdbId, filmTitle: film.title },
          'IMDb RapidAPI critic reviews: quota exceeded (HTTP 429)'
        )
      } else if (criticRes.status === 403) {
        reviewLogger.warn(
          { source: 'IMDB', endpoint: 'critic', imdbId: film.imdbId, filmTitle: film.title },
          'IMDb RapidAPI critic reviews: subscription required (HTTP 403)'
        )
      } else if (!criticRes.ok) {
        reviewLogger.warn(
          { source: 'IMDB', endpoint: 'critic', imdbId: film.imdbId, filmTitle: film.title, status: criticRes.status },
          `IMDb RapidAPI critic reviews: request failed (HTTP ${criticRes.status})`
        )
      } else {
        const criticData = await criticRes.json()
        const criticEdges = criticData?.data?.title?.metacritic?.reviews?.edges || []
        for (const edge of criticEdges.slice(0, 10)) {
          const node = edge.node
          if (!node) continue
          const text = node.quote?.value || ''
          if (text.length > 30) {
            reviews.push({
              sourcePlatform: 'IMDB',
              sourceUrl: node.url || null,
              author: node.reviewer ? `${node.reviewer} (${node.site || 'Critic'})` : node.site || null,
              reviewText: text,
              sourceRating: node.score ? node.score / 10 : null, // Metacritic 0-100 → 0-10
            })
          }
        }
      }
    } catch (criticErr) {
      reviewLogger.warn(
        {
          source: 'IMDB',
          endpoint: 'critic',
          imdbId: film.imdbId,
          filmTitle: film.title,
          error: criticErr instanceof Error ? criticErr.message : String(criticErr),
        },
        'IMDb RapidAPI critic reviews: fetch error'
      )
    }

    reviewLogger.info({ source: 'IMDB', filmTitle: film.title, count: reviews.length }, 'IMDb reviews fetched')
    return { reviews, ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    reviewLogger.error(
      { source: 'IMDB', filmTitle: film.title, error: message },
      'IMDb fetch failed'
    )
    return { reviews: [], ok: false, reason: `error: ${message}` }
  }
}
