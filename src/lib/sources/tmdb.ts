import type { Film } from '@/generated/prisma/client'
import type { FetchedReview } from '@/lib/types'
import { reviewLogger } from '@/lib/logger'

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

export async function fetchTMDBReviews(film: Film): Promise<FetchedReview[]> {
  try {
    const reviews: FetchedReview[] = []

    // Fetch up to 3 pages
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(`${TMDB_BASE_URL}/movie/${film.tmdbId}/reviews?page=${page}`, {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
      })
      if (!res.ok) break
      const data = await res.json()
      const results = data.results || []
      if (results.length === 0) break

      for (const r of results) {
        if (r.content && r.content.length > 50) {
          reviews.push({
            sourcePlatform: 'TMDB',
            sourceUrl: r.url || null,
            author: r.author || null,
            reviewText: r.content,
            sourceRating: r.author_details?.rating ? r.author_details.rating / 2 : null,
          })
        }
      }

      if (data.total_pages <= page) break
    }

    reviewLogger.info({ source: 'TMDB', filmTitle: film.title, count: reviews.length }, 'TMDB reviews fetched')
    return reviews
  } catch (err) {
    reviewLogger.error({ source: 'TMDB', filmTitle: film.title, error: err instanceof Error ? err.message : String(err) }, 'TMDB fetch failed')
    return []
  }
}
