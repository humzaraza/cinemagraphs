import { prisma } from './prisma'
import { createHash } from 'crypto'
import type { Film, ReviewSource } from '@/generated/prisma/client'

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY
const RAPIDAPI_IMDB_HOST = process.env.RAPIDAPI_IMDB_HOST || 'imdb236.p.rapidapi.com'
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET

interface FetchedReview {
  sourcePlatform: ReviewSource
  sourceUrl: string | null
  author: string | null
  reviewText: string
  sourceRating: number | null
}

function contentHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex')
}

// ── TMDB Reviews ──

async function fetchTMDBReviews(film: Film): Promise<FetchedReview[]> {
  try {
    const res = await fetch(`${TMDB_BASE_URL}/movie/${film.tmdbId}/reviews?page=1`, {
      headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
    })
    if (!res.ok) return []
    const data = await res.json()

    return (data.results || [])
      .filter((r: any) => r.content && r.content.length > 50)
      .map((r: any) => ({
        sourcePlatform: 'TMDB' as ReviewSource,
        sourceUrl: r.url || null,
        author: r.author || null,
        reviewText: r.content,
        sourceRating: r.author_details?.rating ? r.author_details.rating / 2 : null,
      }))
  } catch (err) {
    console.error(`[ReviewFetcher] TMDB failed for ${film.title}:`, err)
    return []
  }
}

// ── IMDb Reviews via RapidAPI ──

async function fetchIMDbReviews(film: Film): Promise<FetchedReview[]> {
  if (!RAPIDAPI_KEY || !film.imdbId) return []

  try {
    const reviews: FetchedReview[] = []

    // User reviews
    const userRes = await fetch(
      `https://${RAPIDAPI_IMDB_HOST}/imdb/user-reviews?id=${film.imdbId}`,
      {
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': RAPIDAPI_IMDB_HOST,
        },
      }
    )
    if (userRes.ok) {
      const data = await userRes.json()
      const items = data.reviews || data.results || data || []
      const list = Array.isArray(items) ? items : []
      for (const r of list.slice(0, 15)) {
        const text = r.review || r.content || r.reviewText || r.text || ''
        if (text.length > 50) {
          reviews.push({
            sourcePlatform: 'IMDB' as ReviewSource,
            sourceUrl: r.url || null,
            author: r.author || r.username || null,
            reviewText: text,
            sourceRating: r.rating ? parseFloat(r.rating) : null,
          })
        }
      }
    }

    return reviews
  } catch (err) {
    console.error(`[ReviewFetcher] IMDb failed for ${film.title}:`, err)
    return []
  }
}

// ── Critic Blog Reviews ──

async function fetchCriticReviews(film: Film): Promise<FetchedReview[]> {
  try {
    // Use TMDB's review links endpoint to find critic reviews
    const searchQuery = encodeURIComponent(`${film.title} ${film.releaseDate ? new Date(film.releaseDate).getFullYear() : ''} movie review`)
    const res = await fetch(`${TMDB_BASE_URL}/movie/${film.tmdbId}/reviews?page=1&page=2`, {
      headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
    })
    if (!res.ok) return []

    // Also try fetching external reviews from known critic sites
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
            sourcePlatform: 'CRITIC_BLOG' as ReviewSource,
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

    return reviews
  } catch (err) {
    console.error(`[ReviewFetcher] Critic blogs failed for ${film.title}:`, err)
    return []
  }
}

// ── Letterboxd Reviews ──

async function fetchLetterboxdReviews(film: Film): Promise<FetchedReview[]> {
  try {
    const slug = slugify(film.title)
    const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : ''
    const url = `https://letterboxd.com/film/${slug}${year ? `-${year}` : ''}/reviews/by/activity/`

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Cinemagraphs/1.0 (movie sentiment analysis)' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      // Try without year
      const fallbackUrl = `https://letterboxd.com/film/${slug}/reviews/by/activity/`
      const fallbackRes = await fetch(fallbackUrl, {
        headers: { 'User-Agent': 'Cinemagraphs/1.0 (movie sentiment analysis)' },
        signal: AbortSignal.timeout(8000),
      })
      if (!fallbackRes.ok) return []
      return parseLetterboxdHTML(await fallbackRes.text(), fallbackUrl)
    }

    return parseLetterboxdHTML(await res.text(), url)
  } catch (err) {
    console.error(`[ReviewFetcher] Letterboxd failed for ${film.title}:`, err)
    return []
  }
}

function parseLetterboxdHTML(html: string, baseUrl: string): FetchedReview[] {
  const reviews: FetchedReview[] = []

  // Extract review blocks using regex (avoiding full cheerio parse for this)
  const reviewBodyRegex = /<div class="body-text -prose collapsible-text"[^>]*>([\s\S]*?)<\/div>/g
  const authorRegex = /<a class="context"[^>]*href="\/([^/]+)\//g
  const ratingRegex = /rated-(\d+)/g

  const bodies: string[] = []
  let match
  while ((match = reviewBodyRegex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text.length > 50) bodies.push(text)
  }

  const authors: string[] = []
  while ((match = authorRegex.exec(html)) !== null) {
    authors.push(match[1])
  }

  const ratings: (number | null)[] = []
  while ((match = ratingRegex.exec(html)) !== null) {
    ratings.push(parseInt(match[1], 10) / 2)
  }

  for (let i = 0; i < Math.min(bodies.length, 15); i++) {
    reviews.push({
      sourcePlatform: 'LETTERBOXD' as ReviewSource,
      sourceUrl: baseUrl,
      author: authors[i] || null,
      reviewText: bodies[i].slice(0, 5000),
      sourceRating: ratings[i] || null,
    })
  }

  return reviews
}

// ── Reddit Reviews ──

async function fetchRedditReviews(film: Film): Promise<FetchedReview[]> {
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) return []

  try {
    // Get OAuth token
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
                sourcePlatform: 'REDDIT' as ReviewSource,
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

    return reviews
  } catch (err) {
    console.error(`[ReviewFetcher] Reddit failed for ${film.title}:`, err)
    return []
  }
}

// ── Helpers ──

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function extractArticleText(html: string): string {
  // Remove script, style, nav, header, footer tags
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')

  // Try to find article body
  const articleMatch = clean.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
  if (articleMatch) clean = articleMatch[1]

  // Strip remaining HTML
  clean = clean.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return clean
}

// ── Master Fetcher ──

export async function fetchAllReviews(film: Film): Promise<number> {
  console.log(`[ReviewFetcher] Fetching reviews for "${film.title}"...`)

  const [tmdb, imdb, critic, letterboxd, reddit] = await Promise.allSettled([
    fetchTMDBReviews(film),
    fetchIMDbReviews(film),
    fetchCriticReviews(film),
    fetchLetterboxdReviews(film),
    fetchRedditReviews(film),
  ])

  const allReviews: FetchedReview[] = [
    ...(tmdb.status === 'fulfilled' ? tmdb.value : []),
    ...(imdb.status === 'fulfilled' ? imdb.value : []),
    ...(critic.status === 'fulfilled' ? critic.value : []),
    ...(letterboxd.status === 'fulfilled' ? letterboxd.value : []),
    ...(reddit.status === 'fulfilled' ? reddit.value : []),
  ]

  console.log(`[ReviewFetcher] Collected ${allReviews.length} reviews from all sources`)

  // Deduplicate by content hash and store
  let stored = 0
  for (const review of allReviews) {
    const hash = contentHash(review.reviewText)

    const existing = await prisma.review.findFirst({
      where: { contentHash: hash, filmId: film.id },
    })
    if (existing) continue

    await prisma.review.create({
      data: {
        filmId: film.id,
        sourcePlatform: review.sourcePlatform,
        sourceUrl: review.sourceUrl,
        author: review.author,
        reviewText: review.reviewText,
        sourceRating: review.sourceRating,
        contentHash: hash,
      },
    })
    stored++
  }

  console.log(`[ReviewFetcher] Stored ${stored} new reviews (${allReviews.length - stored} duplicates skipped)`)
  return allReviews.length
}
