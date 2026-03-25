import type { Film } from '@/generated/prisma/client'
import type { FetchedReview } from '@/lib/types'
import { reviewLogger } from '@/lib/logger'

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY
const RAPIDAPI_IMDB_HOST = process.env.RAPIDAPI_IMDB_HOST || 'imdb232.p.rapidapi.com'

export async function fetchIMDbReviews(film: Film): Promise<FetchedReview[]> {
  if (!RAPIDAPI_KEY || !film.imdbId) return []

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

    if (userRes.status === 403) {
      reviewLogger.warn({ source: 'IMDB', host: RAPIDAPI_IMDB_HOST }, 'IMDb RapidAPI 403 — not subscribed. Subscribe at https://rapidapi.com/hub to enable IMDb reviews.')
      return []
    }

    if (userRes.ok) {
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
    }

    // Also fetch critic reviews
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
      if (criticRes.ok) {
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
              sourceRating: node.score ? node.score / 10 : null,  // Metacritic 0-100 → 0-10
            })
          }
        }
      }
    } catch {
      // Critic reviews are a bonus — failure is fine
    }

    reviewLogger.info({ source: 'IMDB', filmTitle: film.title, count: reviews.length }, 'IMDb reviews fetched')
    return reviews
  } catch (err) {
    reviewLogger.error({ source: 'IMDB', filmTitle: film.title, error: err instanceof Error ? err.message : String(err) }, 'IMDb fetch failed')
    return []
  }
}
