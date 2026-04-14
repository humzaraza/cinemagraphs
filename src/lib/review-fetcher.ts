import { prisma } from './prisma'
import { createHash } from 'crypto'
import type { Film } from '@/generated/prisma/client'
import type { FetchedReview } from '@/lib/types'
import { reviewLogger } from './logger'
import {
  fetchTMDBReviews,
  fetchIMDbReviews,
  fetchGuardianReviews,
  fetchCriticReviews,
  fetchLetterboxdReviews,
  fetchRedditReviews,
} from './sources'

function contentHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex')
}

/**
 * Compute a stable hash of a film's review set by sorting per-review
 * contentHashes and sha256-ing the joined result.
 *
 * - Reviews missing a contentHash (legacy rows) are excluded from the hash.
 *   Once those reviews are re-stored with a hash they'll be picked up; until
 *   then they don't influence the result, which is the safest behavior.
 * - Sort order makes the hash insensitive to fetch / insertion order.
 * - Returns a 64-char hex string. Returns the sha256 of empty string when no
 *   hashes are available — distinct from a real review hash, but stable.
 */
export function computeReviewHash(
  reviews: Array<{ contentHash: string | null }>
): string {
  const hashes = reviews
    .map((r) => r.contentHash)
    .filter((h): h is string => h !== null && h.length > 0)
    .sort()
  return createHash('sha256').update(hashes.join('|')).digest('hex')
}

export async function fetchAllReviews(film: Film): Promise<number> {
  reviewLogger.info({ filmId: film.id, filmTitle: film.title }, 'Fetching reviews')

  const results = await Promise.allSettled([
    fetchTMDBReviews(film),
    fetchIMDbReviews(film),
    fetchCriticReviews(film),
    fetchLetterboxdReviews(film),
    fetchRedditReviews(film),
    fetchGuardianReviews(film),
  ])

  // Display names for the end-of-run summary line. The order here must
  // match the fetcher order above.
  const sourceNames = ['TMDB', 'IMDb', 'Roger Ebert', 'Letterboxd', 'Reddit', 'Guardian']
  interface PerSource {
    count: number
    ok: boolean
    reason?: string
  }
  const perSource: Record<string, PerSource> = {}
  const allReviews: FetchedReview[] = []

  results.forEach((r, i) => {
    const name = sourceNames[i]
    if (r.status === 'fulfilled') {
      perSource[name] = { count: r.value.reviews.length, ok: r.value.ok, reason: r.value.reason }
      allReviews.push(...r.value.reviews)
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
      perSource[name] = { count: 0, ok: false, reason }
      reviewLogger.warn({ filmId: film.id, source: name, error: reason }, 'Source fetch rejected')
    }
  })

  // Build the human-readable summary line, e.g.
  //   "Sources checked: TMDB ✓ (2 reviews), IMDb ✗ (429 quota exceeded),
  //    Roger Ebert ✗ (403 blocked), Letterboxd ✗ (Cloudflare blocked),
  //    Reddit ✗ (no credentials), Guardian ✗ (no API key)"
  const summaryParts = sourceNames.map((name) => {
    const s = perSource[name]
    if (s.ok) {
      return `${name} ✓ (${s.count} review${s.count === 1 ? '' : 's'})`
    }
    return `${name} ✗ (${s.reason || 'unknown'})`
  })
  const summaryLine = `Sources checked: ${summaryParts.join(', ')}`

  reviewLogger.info(
    { filmId: film.id, filmTitle: film.title, perSource, total: allReviews.length },
    summaryLine
  )

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

  reviewLogger.info({ filmId: film.id, filmTitle: film.title, stored, duplicatesSkipped: allReviews.length - stored }, 'Reviews stored')
  return allReviews.length
}
