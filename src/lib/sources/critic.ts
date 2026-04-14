import type { Film } from '@/generated/prisma/client'
import type { FetchResult, FetchedReview } from '@/lib/types'
import { slugify, extractArticleText } from './helpers'
import { reviewLogger } from '@/lib/logger'

export async function fetchCriticReviews(film: Film): Promise<FetchResult> {
  try {
    const criticSites = [
      `https://www.rogerebert.com/reviews/${slugify(film.title)}`,
    ]

    const reviews: FetchedReview[] = []
    let sawBlock = false
    let lastNonOkStatus = 0

    for (const url of criticSites) {
      try {
        const pageRes = await fetch(url, {
          headers: { 'User-Agent': 'Cinemagraphs/1.0 (movie sentiment analysis)' },
          signal: AbortSignal.timeout(5000),
        })

        if (pageRes.status === 403) {
          reviewLogger.warn(
            { source: 'CRITIC_BLOG', url, filmTitle: film.title },
            'Roger Ebert: blocked (HTTP 403)'
          )
          sawBlock = true
          lastNonOkStatus = 403
          continue
        }
        if (!pageRes.ok) {
          reviewLogger.warn(
            { source: 'CRITIC_BLOG', url, filmTitle: film.title, status: pageRes.status },
            `Roger Ebert: request failed (HTTP ${pageRes.status})`
          )
          lastNonOkStatus = pageRes.status
          continue
        }

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
      } catch (err) {
        reviewLogger.warn(
          {
            source: 'CRITIC_BLOG',
            url,
            filmTitle: film.title,
            error: err instanceof Error ? err.message : String(err),
          },
          'Roger Ebert: fetch error'
        )
      }
    }

    reviewLogger.info({ source: 'CRITIC_BLOG', filmTitle: film.title, count: reviews.length }, 'Critic blog reviews fetched')

    // If we got reviews, report ok even if some URLs were blocked. If we got
    // nothing AND saw a block, surface "403 blocked" in the summary.
    if (reviews.length === 0 && sawBlock) {
      return { reviews: [], ok: false, reason: '403 blocked' }
    }
    if (reviews.length === 0 && lastNonOkStatus !== 0) {
      return { reviews: [], ok: false, reason: `HTTP ${lastNonOkStatus}` }
    }
    return { reviews, ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    reviewLogger.error(
      { source: 'CRITIC_BLOG', filmTitle: film.title, error: message },
      'Critic blog fetch failed'
    )
    return { reviews: [], ok: false, reason: `error: ${message}` }
  }
}
