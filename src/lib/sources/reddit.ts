import type { Film } from '@/generated/prisma/client'
import type { FetchedReview } from '@/lib/types'
import { reviewLogger } from '@/lib/logger'

const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET

export async function fetchRedditReviews(film: Film): Promise<FetchedReview[]> {
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) return []

  try {
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

    const subreddits = ['movies', 'flicks', 'TrueFilm']
    const reviews: FetchedReview[] = []
    const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : ''

    for (const sub of subreddits) {
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

    reviewLogger.info({ source: 'REDDIT', filmTitle: film.title, count: reviews.length }, 'Reddit reviews fetched')
    return reviews
  } catch (err) {
    reviewLogger.error({ source: 'REDDIT', filmTitle: film.title, error: err instanceof Error ? err.message : String(err) }, 'Reddit fetch failed')
    return []
  }
}
