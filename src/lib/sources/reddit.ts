import type { Film } from '@/generated/prisma/client'
import type { FetchResult, FetchedReview } from '@/lib/types'
import { reviewLogger } from '@/lib/logger'

const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN

const SUBREDDITS = ['movies', 'TrueFilm', 'flicks']

export async function fetchRedditReviews(film: Film): Promise<FetchResult> {
  // Try official Reddit API first
  if (REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET) {
    try {
      const reviews = await fetchRedditReviewsOfficial(film)
      if (reviews.length > 0) return { reviews, ok: true }
    } catch (err) {
      reviewLogger.warn(
        { source: 'REDDIT', filmTitle: film.title, error: err instanceof Error ? err.message : String(err) },
        'Reddit: official API failed, trying Apify fallback'
      )
    }
  }

  // Fall back to Apify
  if (APIFY_API_TOKEN) {
    try {
      const reviews = await fetchRedditReviewsApify(film)
      return { reviews, ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reviewLogger.error(
        { source: 'REDDIT_APIFY', filmTitle: film.title, error: message },
        'Reddit: Apify fetch failed'
      )
      return { reviews: [], ok: false, reason: `Apify error: ${message}` }
    }
  }

  // Neither configured
  if (!REDDIT_CLIENT_ID && !APIFY_API_TOKEN) {
    reviewLogger.warn({ source: 'REDDIT', filmTitle: film.title }, 'Reddit: no credentials configured')
    return { reviews: [], ok: false, reason: 'no credentials' }
  }

  // Official API configured but returned 0 rows, and no Apify fallback.
  // That's a valid "tried and found nothing" outcome.
  return { reviews: [], ok: true }
}

async function fetchRedditReviewsOfficial(film: Film): Promise<FetchedReview[]> {
  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Cinemagraphs/1.0',
    },
    body: 'grant_type=client_credentials',
  })
  if (!tokenRes.ok) return []
  const { access_token } = await tokenRes.json()

  const reviews: FetchedReview[] = []
  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : ''

  for (const sub of SUBREDDITS) {
    try {
      const searchRes = await fetch(
        `https://oauth.reddit.com/r/${sub}/search?q=${encodeURIComponent(`${film.title} ${year}`)}&restrict_sr=on&sort=relevance&limit=3`,
        {
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'User-Agent': 'Cinemagraphs/1.0',
          },
        }
      )
      if (!searchRes.ok) continue
      const searchData = await searchRes.json()

      for (const post of (searchData?.data?.children || []).slice(0, 2)) {
        const permalink = post.data?.permalink
        if (!permalink) continue

        const commentsRes = await fetch(
          `https://oauth.reddit.com${permalink}.json?limit=10&depth=1`,
          {
            headers: {
              'Authorization': `Bearer ${access_token}`,
              'User-Agent': 'Cinemagraphs/1.0',
            },
          }
        )
        if (!commentsRes.ok) continue
        const commentsData = await commentsRes.json()

        const comments = commentsData[1]?.data?.children || []
        for (const comment of comments.slice(0, 5)) {
          const body = comment.data?.body || ''
          if (body.length > 100) {
            reviews.push({
              sourcePlatform: 'REDDIT',
              sourceUrl: `https://reddit.com${permalink}`,
              author: comment.data?.author || null,
              reviewText: body.slice(0, 3000),
              sourceRating: null,
            })
          }
        }
      }
    } catch {
      // Individual subreddit failure is fine
    }
  }

  reviewLogger.info({ source: 'REDDIT', filmTitle: film.title, count: reviews.length }, 'Reddit reviews fetched (official API)')
  return reviews
}

async function fetchRedditReviewsApify(film: Film): Promise<FetchedReview[]> {
  const { ApifyClient } = await import('apify-client')
  const client = new ApifyClient({ token: APIFY_API_TOKEN })

  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : ''
  const query = `${film.title} ${year}`.trim()

  const run = await client.actor('apify/reddit-scraper').call({
    searches: SUBREDDITS.map((sub) => ({
      url: `https://www.reddit.com/r/${sub}/search/?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance`,
      term: query,
    })),
    maxItems: 30,
    maxPostCount: 3,
    maxComments: 10,
    proxy: { useApifyProxy: true },
  }, { waitSecs: 120 })

  const { items } = await client.dataset(run.defaultDatasetId).listItems()

  const reviews: FetchedReview[] = []

  for (const item of items) {
    // Posts with substantial self-text
    const selfText = (item as Record<string, unknown>).body as string | undefined
    const postUrl = (item as Record<string, unknown>).url as string | undefined
    const author = (item as Record<string, unknown>).username as string | undefined

    if (selfText && selfText.length > 100) {
      reviews.push({
        sourcePlatform: 'REDDIT',
        sourceUrl: postUrl || null,
        author: author || null,
        reviewText: selfText.slice(0, 3000),
        sourceRating: null,
      })
    }

    // Comments on the post
    const comments = (item as Record<string, unknown>).comments as Array<Record<string, unknown>> | undefined
    if (comments) {
      for (const comment of comments.slice(0, 5)) {
        const body = comment.body as string | undefined
        if (body && body.length > 100) {
          reviews.push({
            sourcePlatform: 'REDDIT',
            sourceUrl: postUrl || null,
            author: (comment.username as string) || null,
            reviewText: body.slice(0, 3000),
            sourceRating: null,
          })
        }
      }
    }
  }

  reviewLogger.info({ source: 'REDDIT_APIFY', filmTitle: film.title, count: reviews.length }, 'Reddit reviews fetched (Apify)')
  return reviews
}
