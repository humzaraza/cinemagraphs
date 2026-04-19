import type { Film } from '@/generated/prisma/client'
import type { FetchResult, FetchedReview } from '@/lib/types'
import { reviewLogger } from '@/lib/logger'

const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN

const SUBREDDITS = ['movies', 'TrueFilm', 'flicks']

const MIN_REVIEW_LENGTH = 200
const MIN_LINK_COMMENT_LENGTH = 400

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
  reason?: 'too_short' | 'link_dump' | 'no_director'
}

// Decides whether a Reddit comment/post body looks like a review about the
// target film. Enforces a minimum length (filters quips/one-liners), rejects
// short link-dump comments, and — if we have a director on the Film record —
// requires at least one director surname in the body.
export function shouldKeepRedditBody(
  body: string,
  directorSurnames: string[]
): KeepDecision {
  if (body.length < MIN_REVIEW_LENGTH) {
    return { keep: false, reason: 'too_short' }
  }

  const hasLink = body.includes('http://') || body.includes('https://')
  if (hasLink && body.length < MIN_LINK_COMMENT_LENGTH) {
    return { keep: false, reason: 'link_dump' }
  }

  if (directorSurnames.length > 0) {
    const bodyLower = body.toLowerCase()
    const hasSurname = directorSurnames.some((s) => bodyLower.includes(s.toLowerCase()))
    if (!hasSurname) {
      return { keep: false, reason: 'no_director' }
    }
  }

  return { keep: true }
}

export async function fetchRedditReviews(
  film: Film
): Promise<FetchResult & { rejectedCount?: number }> {
  const hasDirector = !!(film.director && film.director.trim())
  const directorSurnames = hasDirector ? extractDirectorSurnames(film.director!) : []
  if (!hasDirector) {
    reviewLogger.warn(
      { source: 'REDDIT', filmTitle: film.title },
      'Reddit: director-based verification skipped — director missing'
    )
  }

  // Try official Reddit API first
  if (REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET) {
    try {
      const { reviews, rejectedCount } = await fetchRedditReviewsOfficial(film, directorSurnames)
      if (reviews.length > 0) return { reviews, ok: true, rejectedCount }
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
      const { reviews, rejectedCount } = await fetchRedditReviewsApify(film, directorSurnames)
      return { reviews, ok: true, rejectedCount }
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

interface FetchOutcome {
  reviews: FetchedReview[]
  rejectedCount: number
}

async function fetchRedditReviewsOfficial(
  film: Film,
  directorSurnames: string[]
): Promise<FetchOutcome> {
  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Cinemagraphs/1.0',
    },
    body: 'grant_type=client_credentials',
  })
  if (!tokenRes.ok) return { reviews: [], rejectedCount: 0 }
  const { access_token } = await tokenRes.json()

  const reviews: FetchedReview[] = []
  let rejectedCount = 0
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
          const decision = shouldKeepRedditBody(body, directorSurnames)
          if (!decision.keep) {
            if (decision.reason === 'no_director') rejectedCount++
            if (decision.reason) {
              reviewLogger.debug(
                {
                  source: 'REDDIT',
                  filmTitle: film.title,
                  permalink,
                  bodyLen: body.length,
                  reason: decision.reason,
                  surnames: directorSurnames,
                },
                'Reddit: rejected comment'
              )
            }
            continue
          }
          reviews.push({
            sourcePlatform: 'REDDIT',
            sourceUrl: `https://reddit.com${permalink}`,
            author: comment.data?.author || null,
            reviewText: body.slice(0, 3000),
            sourceRating: null,
          })
        }
      }
    } catch {
      // Individual subreddit failure is fine
    }
  }

  reviewLogger.info(
    { source: 'REDDIT', filmTitle: film.title, count: reviews.length, rejectedCount },
    'Reddit reviews fetched (official API)'
  )
  return { reviews, rejectedCount }
}

async function fetchRedditReviewsApify(
  film: Film,
  directorSurnames: string[]
): Promise<FetchOutcome> {
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
  let rejectedCount = 0

  const considerBody = (body: string | undefined, url: string | undefined, author: string | undefined) => {
    if (!body) return
    const decision = shouldKeepRedditBody(body, directorSurnames)
    if (!decision.keep) {
      if (decision.reason === 'no_director') rejectedCount++
      if (decision.reason) {
        reviewLogger.debug(
          {
            source: 'REDDIT_APIFY',
            filmTitle: film.title,
            url,
            bodyLen: body.length,
            reason: decision.reason,
            surnames: directorSurnames,
          },
          'Reddit: rejected comment'
        )
      }
      return
    }
    reviews.push({
      sourcePlatform: 'REDDIT',
      sourceUrl: url || null,
      author: author || null,
      reviewText: body.slice(0, 3000),
      sourceRating: null,
    })
  }

  for (const item of items) {
    const selfText = (item as Record<string, unknown>).body as string | undefined
    const postUrl = (item as Record<string, unknown>).url as string | undefined
    const author = (item as Record<string, unknown>).username as string | undefined

    considerBody(selfText, postUrl, author)

    const comments = (item as Record<string, unknown>).comments as Array<Record<string, unknown>> | undefined
    if (comments) {
      for (const comment of comments.slice(0, 5)) {
        considerBody(
          comment.body as string | undefined,
          postUrl,
          comment.username as string | undefined
        )
      }
    }
  }

  reviewLogger.info(
    { source: 'REDDIT_APIFY', filmTitle: film.title, count: reviews.length, rejectedCount },
    'Reddit reviews fetched (Apify)'
  )
  return { reviews, rejectedCount }
}
