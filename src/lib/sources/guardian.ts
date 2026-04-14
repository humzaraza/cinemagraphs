import type { Film } from '@/generated/prisma/client'
import type { FetchResult, FetchedReview } from '@/lib/types'
import { reviewLogger } from '@/lib/logger'

// The Guardian Open Platform API — free tier with "test" key. We still fall
// back to the test key for local dev continuity, but a missing real key is
// surfaced in the per-call warn log and marks the source ✗ in the summary.
const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY
const USING_TEST_KEY = !GUARDIAN_API_KEY
const EFFECTIVE_KEY = GUARDIAN_API_KEY || 'test'

export async function fetchGuardianReviews(film: Film): Promise<FetchResult> {
  if (USING_TEST_KEY) {
    reviewLogger.warn(
      { source: 'GUARDIAN', filmTitle: film.title },
      'Guardian: GUARDIAN_API_KEY not set, using test key'
    )
  }

  try {
    const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : ''
    const title = film.title

    // Search for reviews with date range around release
    const fromDate = year ? `${year - 1}-01-01` : ''
    const toDate = year ? `${year + 2}-12-31` : ''

    const queries = [
      `"${title}" review`,
      `${title} film review ${year}`,
    ]

    const reviews: FetchedReview[] = []
    const seenUrls = new Set<string>()

    for (const query of queries) {
      try {
        let url = `https://content.guardianapis.com/search?q=${encodeURIComponent(query)}&section=film&tag=tone/reviews&show-fields=bodyText,byline&page-size=5&api-key=${EFFECTIVE_KEY}`
        if (fromDate) url += `&from-date=${fromDate}`
        if (toDate) url += `&to-date=${toDate}`

        const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
        if (!res.ok) {
          reviewLogger.warn(
            { source: 'GUARDIAN', filmTitle: film.title, query, status: res.status },
            `Guardian: search failed (HTTP ${res.status})`
          )
          continue
        }

        const data = await res.json()
        const results = data?.response?.results || []

        for (const article of results) {
          const bodyText = article?.fields?.bodyText || ''
          const webUrl = article?.webUrl || ''
          const webTitle = (article?.webTitle || '').toLowerCase()

          // Only include if it mentions the film title
          if (!webTitle.includes(title.toLowerCase()) && !bodyText.toLowerCase().includes(title.toLowerCase())) continue
          if (bodyText.length < 200) continue
          if (seenUrls.has(webUrl)) continue
          seenUrls.add(webUrl)

          reviews.push({
            sourcePlatform: 'GUARDIAN',
            sourceUrl: webUrl,
            author: article?.fields?.byline || 'The Guardian',
            reviewText: bodyText.slice(0, 6000),
            sourceRating: null,
          })
        }
      } catch (err) {
        reviewLogger.warn(
          {
            source: 'GUARDIAN',
            filmTitle: film.title,
            query,
            error: err instanceof Error ? err.message : String(err),
          },
          'Guardian: query error'
        )
      }
    }

    // Also try a broader search without the reviews tag
    if (reviews.length === 0) {
      try {
        let url = `https://content.guardianapis.com/search?q=${encodeURIComponent(`"${title}" ${year} film`)}&section=film&show-fields=bodyText,byline&page-size=5&api-key=${EFFECTIVE_KEY}`
        if (fromDate) url += `&from-date=${fromDate}`
        if (toDate) url += `&to-date=${toDate}`

        const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
        if (!res.ok) {
          reviewLogger.warn(
            { source: 'GUARDIAN', filmTitle: film.title, query: 'fallback', status: res.status },
            `Guardian: fallback search failed (HTTP ${res.status})`
          )
        } else {
          const data = await res.json()
          for (const article of (data?.response?.results || [])) {
            const bodyText = article?.fields?.bodyText || ''
            const webUrl = article?.webUrl || ''
            const webTitle = (article?.webTitle || '').toLowerCase()

            if (!webTitle.includes(title.toLowerCase()) && !bodyText.toLowerCase().includes(title.toLowerCase())) continue
            if (bodyText.length < 500) continue
            if (seenUrls.has(webUrl)) continue
            seenUrls.add(webUrl)

            reviews.push({
              sourcePlatform: 'GUARDIAN',
              sourceUrl: webUrl,
              author: article?.fields?.byline || 'The Guardian',
              reviewText: bodyText.slice(0, 6000),
              sourceRating: null,
            })
          }
        }
      } catch (err) {
        reviewLogger.warn(
          {
            source: 'GUARDIAN',
            filmTitle: film.title,
            query: 'fallback',
            error: err instanceof Error ? err.message : String(err),
          },
          'Guardian: fallback query error'
        )
      }
    }

    reviewLogger.info({ source: 'GUARDIAN', filmTitle: film.title, count: reviews.length }, 'Guardian reviews fetched')

    // Treat a missing real API key as a failure in the summary even if the
    // test-key fallback returned rows — this keeps the "you need to set this"
    // signal visible without dropping any data we did get.
    if (USING_TEST_KEY) {
      return { reviews, ok: false, reason: 'no API key' }
    }
    return { reviews, ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    reviewLogger.error(
      { source: 'GUARDIAN', filmTitle: film.title, error: message },
      'Guardian fetch failed'
    )
    return { reviews: [], ok: false, reason: `error: ${message}` }
  }
}
