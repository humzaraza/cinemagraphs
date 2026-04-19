import type { Film } from '@/generated/prisma/client'
import type { FetchResult, FetchedReview } from '@/lib/types'
import { reviewLogger } from '@/lib/logger'

// The Guardian Open Platform API — free tier with "test" key. We still fall
// back to the test key for local dev continuity, but a missing real key is
// surfaced in the per-call warn log and marks the source ✗ in the summary.
const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY
const USING_TEST_KEY = !GUARDIAN_API_KEY
const EFFECTIVE_KEY = GUARDIAN_API_KEY || 'test'

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

interface KeepDecision {
  keep: boolean
  rejectedByDirector: boolean
}

// Decides whether a Guardian article is actually about the target film.
// Title must appear in the headline or body, and — if we have a director on
// the Film record — at least one director surname must also appear in the
// body. Returning `rejectedByDirector: true` lets the caller distinguish the
// new director-mismatch rejections from plain title misses for observability.
function shouldKeepArticle(
  article: { webTitle?: string; fields?: { bodyText?: string } },
  title: string,
  directorSurnames: string[]
): KeepDecision {
  const bodyText = article?.fields?.bodyText || ''
  const webTitleLower = (article?.webTitle || '').toLowerCase()
  const titleLower = title.toLowerCase()
  const bodyLower = bodyText.toLowerCase()

  if (!webTitleLower.includes(titleLower) && !bodyLower.includes(titleLower)) {
    return { keep: false, rejectedByDirector: false }
  }

  if (directorSurnames.length > 0) {
    const hasSurname = directorSurnames.some((s) => bodyLower.includes(s.toLowerCase()))
    if (!hasSurname) {
      return { keep: false, rejectedByDirector: true }
    }
  }

  return { keep: true, rejectedByDirector: false }
}

export async function fetchGuardianReviews(
  film: Film
): Promise<FetchResult & { rejectedCount?: number }> {
  if (USING_TEST_KEY) {
    reviewLogger.warn(
      { source: 'GUARDIAN', filmTitle: film.title },
      'Guardian: GUARDIAN_API_KEY not set, using test key'
    )
  }

  try {
    const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : ''
    const title = film.title

    const hasDirector = !!(film.director && film.director.trim())
    const directorSurnames = hasDirector ? extractDirectorSurnames(film.director!) : []
    if (!hasDirector) {
      reviewLogger.warn(
        { source: 'GUARDIAN', filmTitle: film.title },
        'Guardian: director-based verification skipped — director missing'
      )
    }

    // Search for reviews with date range around release
    const fromDate = year ? `${year - 1}-01-01` : ''
    const toDate = year ? `${year + 2}-12-31` : ''

    const queries = [
      `"${title}" ${year} review`,
      `"${title}" ${year} film`,
    ]

    const reviews: FetchedReview[] = []
    const seenUrls = new Set<string>()
    let rejectedCount = 0

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

          const { keep, rejectedByDirector } = shouldKeepArticle(article, title, directorSurnames)
          if (!keep) {
            if (rejectedByDirector) {
              rejectedCount++
              reviewLogger.debug(
                {
                  source: 'GUARDIAN',
                  filmTitle: film.title,
                  webTitle: article?.webTitle,
                  webUrl,
                  surnames: directorSurnames,
                },
                'Guardian: rejected — no director surname in body'
              )
            }
            continue
          }

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

    reviewLogger.info(
      {
        source: 'GUARDIAN',
        filmTitle: film.title,
        count: reviews.length,
        rejectedCount,
      },
      'Guardian reviews fetched'
    )

    // Treat a missing real API key as a failure in the summary even if the
    // test-key fallback returned rows — this keeps the "you need to set this"
    // signal visible without dropping any data we did get.
    if (USING_TEST_KEY) {
      return { reviews, ok: false, reason: 'no API key', rejectedCount }
    }
    return { reviews, ok: true, rejectedCount }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    reviewLogger.error(
      { source: 'GUARDIAN', filmTitle: film.title, error: message },
      'Guardian fetch failed'
    )
    return { reviews: [], ok: false, reason: `error: ${message}` }
  }
}
