import type { Film } from '@/generated/prisma/client'
import type { FetchedReview } from '@/lib/types'
import { slugify } from './helpers'

// Note: Letterboxd uses Cloudflare anti-bot protection.
// Server-side fetching will be blocked with a JS challenge page.
// This source is kept for future headless browser support.

export async function fetchLetterboxdReviews(film: Film): Promise<FetchedReview[]> {
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
      sourcePlatform: 'LETTERBOXD',
      sourceUrl: baseUrl,
      author: authors[i] || null,
      reviewText: bodies[i].slice(0, 5000),
      sourceRating: ratings[i] || null,
    })
  }

  return reviews
}
