import { prisma } from './prisma'
import { createHash } from 'crypto'
import type { Film, ReviewSource } from '@/generated/prisma/client'

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY
const RAPIDAPI_IMDB_HOST = process.env.RAPIDAPI_IMDB_HOST || 'imdb236.p.rapidapi.com'
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET

// The Guardian Open Platform API - free tier with "test" key
const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY || 'test'

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

// ── TMDB Reviews (multi-page) ──

async function fetchTMDBReviews(film: Film): Promise<FetchedReview[]> {
  try {
    const reviews: FetchedReview[] = []

    // Fetch up to 3 pages
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(`${TMDB_BASE_URL}/movie/${film.tmdbId}/reviews?page=${page}`, {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
      })
      if (!res.ok) break
      const data = await res.json()
      const results = data.results || []
      if (results.length === 0) break

      for (const r of results) {
        if (r.content && r.content.length > 50) {
          reviews.push({
            sourcePlatform: 'TMDB' as ReviewSource,
            sourceUrl: r.url || null,
            author: r.author || null,
            reviewText: r.content,
            sourceRating: r.author_details?.rating ? r.author_details.rating / 2 : null,
          })
        }
      }

      if (data.total_pages <= page) break
    }

    console.log(`[ReviewFetcher] TMDB: ${reviews.length} reviews for "${film.title}"`)
    return reviews
  } catch (err) {
    console.error(`[ReviewFetcher] TMDB failed for ${film.title}:`, err)
    return []
  }
}

// ── IMDb Reviews via RapidAPI (imdb232) ──

async function fetchIMDbReviews(film: Film): Promise<FetchedReview[]> {
  if (!RAPIDAPI_KEY || !film.imdbId) return []

  try {
    const reviews: FetchedReview[] = []

    // imdb232 API: /api/title/get-user-reviews with param "tt"
    const userRes = await fetch(
      `https://${RAPIDAPI_IMDB_HOST}/api/title/get-user-reviews?tt=${film.imdbId}&sortBy=HELPFULNESS_SCORE&spoiler=EXCLUDE`,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': RAPIDAPI_IMDB_HOST,
        },
        signal: AbortSignal.timeout(10000),
      }
    )

    if (userRes.status === 403) {
      console.warn(`[ReviewFetcher] IMDb RapidAPI 403 — not subscribed to ${RAPIDAPI_IMDB_HOST}. Subscribe at https://rapidapi.com/hub to enable IMDb reviews.`)
      return []
    }

    if (userRes.ok) {
      const data = await userRes.json()
      const edges = data?.data?.title?.reviews?.edges || []
      for (const edge of edges.slice(0, 15)) {
        const node = edge.node
        if (!node) continue
        const text = node.text?.originalText?.plainText || ''
        if (text.length > 50) {
          reviews.push({
            sourcePlatform: 'IMDB' as ReviewSource,
            sourceUrl: `https://www.imdb.com/review/${node.id}/`,
            author: node.author?.nickName || null,
            reviewText: text,
            sourceRating: node.authorRating ? node.authorRating : null,
          })
        }
      }
    }

    // Also fetch critic reviews
    try {
      const criticRes = await fetch(
        `https://${RAPIDAPI_IMDB_HOST}/api/title/get-critic-reviews?tt=${film.imdbId}`,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-rapidapi-key': RAPIDAPI_KEY,
            'x-rapidapi-host': RAPIDAPI_IMDB_HOST,
          },
          signal: AbortSignal.timeout(10000),
        }
      )
      if (criticRes.ok) {
        const criticData = await criticRes.json()
        const criticEdges = criticData?.data?.title?.metacritic?.reviews?.edges || []
        for (const edge of criticEdges.slice(0, 10)) {
          const node = edge.node
          if (!node) continue
          const text = node.quote?.value || ''
          if (text.length > 30) {
            reviews.push({
              sourcePlatform: 'IMDB' as ReviewSource,
              sourceUrl: node.url || null,
              author: node.reviewer ? `${node.reviewer} (${node.site || 'Critic'})` : node.site || null,
              reviewText: text,
              sourceRating: node.score ? node.score / 10 : null,  // Metacritic 0-100 → 0-10
            })
          }
        }
      }
    } catch {
      // Critic reviews are a bonus — failure is fine
    }

    console.log(`[ReviewFetcher] IMDb: ${reviews.length} reviews for "${film.title}"`)
    return reviews
  } catch (err) {
    console.error(`[ReviewFetcher] IMDb failed for ${film.title}:`, err)
    return []
  }
}

// ── The Guardian Reviews (free Open Platform API) ──

async function fetchGuardianReviews(film: Film): Promise<FetchedReview[]> {
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
            sourcePlatform: 'GUARDIAN' as ReviewSource,
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
              sourcePlatform: 'GUARDIAN' as ReviewSource,
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

// ── Critic Blog Reviews ──

async function fetchCriticReviews(film: Film): Promise<FetchedReview[]> {
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

    console.log(`[ReviewFetcher] Critic blogs: ${reviews.length} reviews for "${film.title}"`)
    return reviews
  } catch (err) {
    console.error(`[ReviewFetcher] Critic blogs failed for ${film.title}:`, err)
    return []
  }
}

// ── Letterboxd Reviews ──
// Note: Letterboxd uses Cloudflare anti-bot protection.
// Server-side fetching will be blocked with a JS challenge page.
// This source is kept for future headless browser support.

async function fetchLetterboxdReviews(film: Film): Promise<FetchedReview[]> {
  try {
    const slug = slugify(film.title)
    const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : ''

    // Try with year suffix first, then without
    const urls = [
      `https://letterboxd.com/film/${slug}${year ? `-${year}` : ''}/reviews/by/activity/`,
      `https://letterboxd.com/film/${slug}/reviews/by/activity/`,
    ]

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(8000),
        })

        if (!res.ok) continue

        const html = await res.text()

        // Detect Cloudflare challenge
        if (html.includes('Just a moment...') || html.includes('cf_chl_opt') || html.includes('challenge-platform')) {
          console.warn(`[ReviewFetcher] Letterboxd blocked by Cloudflare for "${film.title}" — skipping`)
          return []
        }

        const reviews = parseLetterboxdHTML(html, url)
        if (reviews.length > 0) {
          console.log(`[ReviewFetcher] Letterboxd: ${reviews.length} reviews for "${film.title}"`)
          return reviews
        }
      } catch {
        continue
      }
    }

    console.log(`[ReviewFetcher] Letterboxd: 0 reviews for "${film.title}" (Cloudflare blocked)`)
    return []
  } catch (err) {
    console.error(`[ReviewFetcher] Letterboxd failed for ${film.title}:`, err)
    return []
  }
}

function parseLetterboxdHTML(html: string, baseUrl: string): FetchedReview[] {
  const reviews: FetchedReview[] = []

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

    console.log(`[ReviewFetcher] Reddit: ${reviews.length} reviews for "${film.title}"`)
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
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')

  const articleMatch = clean.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
  if (articleMatch) clean = articleMatch[1]

  clean = clean.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return clean
}

// ── Master Fetcher ──

export async function fetchAllReviews(film: Film): Promise<number> {
  console.log(`[ReviewFetcher] Fetching reviews for "${film.title}"...`)

  const [tmdb, imdb, critic, letterboxd, reddit, guardian] = await Promise.allSettled([
    fetchTMDBReviews(film),
    fetchIMDbReviews(film),
    fetchCriticReviews(film),
    fetchLetterboxdReviews(film),
    fetchRedditReviews(film),
    fetchGuardianReviews(film),
  ])

  const allReviews: FetchedReview[] = [
    ...(tmdb.status === 'fulfilled' ? tmdb.value : []),
    ...(imdb.status === 'fulfilled' ? imdb.value : []),
    ...(critic.status === 'fulfilled' ? critic.value : []),
    ...(letterboxd.status === 'fulfilled' ? letterboxd.value : []),
    ...(reddit.status === 'fulfilled' ? reddit.value : []),
    ...(guardian.status === 'fulfilled' ? guardian.value : []),
  ]

  // Log source breakdown
  const sourceCounts: Record<string, number> = {}
  for (const r of allReviews) {
    sourceCounts[r.sourcePlatform] = (sourceCounts[r.sourcePlatform] || 0) + 1
  }
  console.log(`[ReviewFetcher] Source breakdown:`, sourceCounts)
  console.log(`[ReviewFetcher] Total: ${allReviews.length} reviews from all sources`)

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
