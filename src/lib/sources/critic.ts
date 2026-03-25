import type { Film } from '@/generated/prisma/client'
import type { FetchedReview } from '@/lib/types'
import { slugify, extractArticleText } from './helpers'
import { reviewLogger } from '@/lib/logger'

export async function fetchCriticReviews(film: Film): Promise<FetchedReview[]> {
  try {
    const criticSites = [
      `https://www.rogerebert.com/reviews/${slugify(film.title)}`,
    ]

    const reviews: FetchedReview[] = []

    for (const url of criticSites) {
      try {
        const pageRes = await fetch(url, {
          headers: { 'User-Agent': 'Cinemagraphs/1.0 (movie sentiment analysis)' },
          signal: AbortSignal.timeout(5000),
        })
        if (!pageRes.ok) continue

        const html = await pageRes.text()
        const text = extractArticleText(html)
        if (text && text.length > 200) {
          reviews.push({
            sourcePlatform: 'CRITIC_BLOG',
            sourceUrl: url,
            author: 'Roger Ebert',
            reviewText: text.slice(0, 5000),
            sourceRating: null,
          })
        }
      } catch {
        // Individual critic fetch failure is fine
      }
    }

    reviewLogger.info({ source: 'CRITIC_BLOG', filmTitle: film.title, count: reviews.length }, 'Critic blog reviews fetched')
    return reviews
  } catch (err) {
    reviewLogger.error({ source: 'CRITIC_BLOG', filmTitle: film.title, error: err instanceof Error ? err.message : String(err) }, 'Critic blog fetch failed')
    return []
  }
}
