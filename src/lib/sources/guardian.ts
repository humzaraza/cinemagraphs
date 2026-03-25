import type { Film } from '@/generated/prisma/client'
import type { FetchedReview } from '@/lib/types'

// The Guardian Open Platform API - free tier with "test" key
const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY || 'test'

export async function fetchGuardianReviews(film: Film): Promise<FetchedReview[]> {
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
        let url = `https://content.guardianapis.com/search?q=${encodeURIComponent(query)}&section=film&tag=tone/reviews&show-fields=bodyText,byline&page-size=5&api-key=${GUARDIAN_API_KEY}`
        if (fromDate) url += `&from-date=${fromDate}`
        if (toDate) url += `&to-date=${toDate}`

        const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
        if (!res.ok) continue

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
      } catch {
        // Individual query failure is fine
      }
    }

    // Also try a broader search without the reviews tag
    if (reviews.length === 0) {
      try {
        let url = `https://content.guardianapis.com/search?q=${encodeURIComponent(`"${title}" ${year} film`)}&section=film&show-fields=bodyText,byline&page-size=5&api-key=${GUARDIAN_API_KEY}`
        if (fromDate) url += `&from-date=${fromDate}`
        if (toDate) url += `&to-date=${toDate}`

        const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
        if (res.ok) {
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
      } catch {
        // Fallback search failure is fine
      }
    }

    console.log(`[ReviewFetcher] Guardian: ${reviews.length} reviews for "${film.title}"`)
    return reviews
  } catch (err) {
    console.error(`[ReviewFetcher] Guardian failed for ${film.title}:`, err)
    return []
  }
}
