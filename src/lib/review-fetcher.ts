import { prisma } from './prisma'
import { createHash } from 'crypto'
import type { Film } from '@/generated/prisma/client'
import type { FetchedReview } from '@/lib/types'
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
