import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { fetchIMDbReviews } from '@/lib/sources/imdb'
import { apiLogger } from '@/lib/logger'
import { createHash } from 'crypto'

export const maxDuration = 300 // 5 minutes for Vercel

// Leave a 20s buffer below maxDuration so we can finish writing the summary
// row + returning a response before Vercel kills the function.
const TIME_BUDGET_MS = 280_000
const DELAY_BETWEEN_FILMS_MS = 1000

function contentHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex')
}

/**
 * Admin endpoint: backfill IMDb reviews for every film that has a valid
 * imdbId but zero IMDB-source reviews in the Review table.
 *
 * This runs ONLY the IMDb source fetcher — not the full sentiment pipeline,
 * no Claude calls, no cost. The goal is to patch over the silent-failure
 * gap caused by the earlier RapidAPI quota cliff: films that were processed
 * while the quota was exhausted got zero IMDb rows and no warning log, so
 * this endpoint just re-runs the IMDb fetch for them.
 *
 * Processed sequentially with a 1-second delay between films so we stay
 * well inside the RapidAPI per-second burst limit. If we approach the
 * Vercel function timeout the loop stops cleanly and the summary reports
 * how far we got — call again to resume from where we stopped.
 */
export async function POST() {
  const session = await getMobileOrServerSession()
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 403 })
  }

  const startTime = Date.now()
  const deadline = startTime + TIME_BUDGET_MS

  try {
    // Films with imdbId set AND no existing IMDB-source reviews. Ordered
    // oldest-first so each run makes forward progress on the backlog.
    const candidates = await prisma.film.findMany({
      where: {
        imdbId: { not: null },
        reviews: { none: { sourcePlatform: 'IMDB' } },
      },
      orderBy: { createdAt: 'asc' },
    })

    const total = candidates.length
    apiLogger.info({ total }, `IMDb backfill starting: ${total} films need reviews`)

    let processed = 0
    let newReviewsStored = 0
    let filmsGotReviews = 0
    let timedOut = false
    let stoppedAtIndex = -1
    let stoppedAtTitle: string | null = null

    for (let i = 0; i < candidates.length; i++) {
      const film = candidates[i]

      if (Date.now() > deadline) {
        timedOut = true
        stoppedAtIndex = i
        stoppedAtTitle = film.title
        apiLogger.warn(
          { stoppedAtIndex: i, stoppedAtTitle: film.title, processed, total },
          `IMDb backfill approaching timeout — stopping at ${film.title} (${i + 1}/${total})`
        )
        break
      }

      try {
        const result = await fetchIMDbReviews(film)

        let filmStored = 0
        if (result.ok) {
          // Dedupe by contentHash — same logic as fetchAllReviews uses. We
          // can't call fetchAllReviews here because this endpoint must only
          // hit the IMDb source.
          for (const review of result.reviews) {
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
            filmStored++
          }
          newReviewsStored += filmStored
          if (filmStored > 0) filmsGotReviews++

          apiLogger.info(
            {
              filmId: film.id,
              filmTitle: film.title,
              n: i + 1,
              total,
              imdbFetched: result.reviews.length,
              imdbStored: filmStored,
            },
            `Fetching IMDb reviews for ${film.title} (${i + 1}/${total})... got ${filmStored} reviews`
          )
        } else {
          apiLogger.warn(
            {
              filmId: film.id,
              filmTitle: film.title,
              n: i + 1,
              total,
              reason: result.reason,
            },
            `Fetching IMDb reviews for ${film.title} (${i + 1}/${total})... FAILED: ${result.reason}`
          )
        }
        processed++
      } catch (err) {
        apiLogger.error(
          { err, filmId: film.id, filmTitle: film.title },
          'IMDb backfill: per-film error'
        )
        processed++
      }

      if (i < candidates.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_FILMS_MS))
      }
    }

    const stillMissing = total - filmsGotReviews
    const durationMs = Date.now() - startTime

    apiLogger.info(
      {
        total,
        processed,
        newReviewsStored,
        filmsGotReviews,
        stillMissing,
        timedOut,
        stoppedAtIndex,
        stoppedAtTitle,
        durationMs,
      },
      `${total} films processed, ${newReviewsStored} new reviews stored, ${stillMissing} films still have 0 IMDb reviews`
    )

    return Response.json({
      total,
      processed,
      newReviewsStored,
      filmsGotReviews,
      stillMissing,
      timedOut,
      stoppedAtIndex: timedOut ? stoppedAtIndex : null,
      stoppedAtTitle: timedOut ? stoppedAtTitle : null,
      durationMs,
    })
  } catch (err) {
    apiLogger.error({ err }, 'IMDb backfill failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
