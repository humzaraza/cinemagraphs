import type { Film } from '@/generated/prisma/client'
import type { FetchResult, FetchedReview } from '@/lib/types'
import { slugify, extractArticleText } from './helpers'
import { reviewLogger } from '@/lib/logger'

// "Christopher Nolan" → ["Nolan"]; "Phil Lord, Christopher Miller" → ["Lord", "Miller"].
// Splits on commas or the word "and" to separate co-directors, then takes the
// last whitespace-separated token of each name as the surname.
function extractDirectorSurnames(director: string): string[] {
  return director
    .split(/,|\s+and\s+/i)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const words = name.split(/\s+/).filter(Boolean)
      return words[words.length - 1] || ''
    })
    .filter(Boolean)
}

export async function fetchCriticReviews(
  film: Film
): Promise<FetchResult & { rejectedCount?: number }> {
  try {
    const criticSites = [
      `https://www.rogerebert.com/reviews/${slugify(film.title)}`,
    ]

    const hasDirector = !!(film.director && film.director.trim())
    const directorSurnames = hasDirector ? extractDirectorSurnames(film.director!) : []
    if (!hasDirector) {
      reviewLogger.warn(
        { source: 'CRITIC_BLOG', filmTitle: film.title },
        'Critic blog: director-based verification skipped — director missing'
      )
    }

    const reviews: FetchedReview[] = []
    let rejectedCount = 0
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
        if (!text || text.length <= 200) continue

        if (directorSurnames.length > 0) {
          const bodyLower = text.toLowerCase()
          const hasSurname = directorSurnames.some((s) => bodyLower.includes(s.toLowerCase()))
          if (!hasSurname) {
            rejectedCount++
            reviewLogger.debug(
              {
                source: 'CRITIC_BLOG',
                filmId: film.id,
                filmTitle: film.title,
                director: film.director,
                url,
                surnames: directorSurnames,
              },
              'Critic blog: rejected — no director surname in body'
            )
            continue
          }
        }

        reviews.push({
          sourcePlatform: 'CRITIC_BLOG',
          sourceUrl: url,
          author: 'Roger Ebert',
          reviewText: text.slice(0, 5000),
          sourceRating: null,
        })
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

    reviewLogger.info(
      { source: 'CRITIC_BLOG', filmTitle: film.title, count: reviews.length, rejectedCount },
      'Critic blog reviews fetched'
    )

    // If we got reviews, report ok even if some URLs were blocked. If we got
    // nothing AND saw a block, surface "403 blocked" in the summary.
    if (reviews.length === 0 && sawBlock) {
      return { reviews: [], ok: false, reason: '403 blocked', rejectedCount }
    }
    if (reviews.length === 0 && lastNonOkStatus !== 0) {
      return { reviews: [], ok: false, reason: `HTTP ${lastNonOkStatus}`, rejectedCount }
    }
    return { reviews, ok: true, rejectedCount }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    reviewLogger.error(
      { source: 'CRITIC_BLOG', filmTitle: film.title, error: message },
      'Critic blog fetch failed'
    )
    return { reviews: [], ok: false, reason: `error: ${message}` }
  }
}
