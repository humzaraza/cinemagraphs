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

  const sourceNames = ['TMDB', 'IMDb', 'Critic', 'Letterboxd', 'Reddit', 'Guardian']
  const perSource: Record<string, number> = {}
  const allReviews: FetchedReview[] = []

  results.forEach((r, i) => {
    const name = sourceNames[i]
    if (r.status === 'fulfilled') {
      perSource[name] = r.value.length
      allReviews.push(...r.value)
    } else {
      perSource[name] = 0
      reviewLogger.warn({ filmId: film.id, source: name, error: r.reason?.message ?? String(r.reason) }, 'Source fetch failed')
    }
  })

  reviewLogger.info({ filmId: film.id, filmTitle: film.title, perSource, total: allReviews.length }, 'Review source breakdown')

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
