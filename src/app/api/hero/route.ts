import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { withDerivedFields } from '@/lib/films'
import { cachedQuery } from '@/lib/cache'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import {
  fetchHeroCandidates,
  pickDailyHero,
  stampHeroFeatured,
  heroDateParts,
  secondsUntilHeroMidnight,
} from '@/lib/hero'

// The pick depends on the wall-clock date, so never prerender this.
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const now = new Date()
    const { year, month, day } = heroDateParts(now)
    // Day-keyed cache: the key rolls over at the HERO_TIMEZONE midnight, so the
    // same film is served all day. The pick is deterministic, so even a
    // mid-day recompute (cache miss) yields the same film.
    const cacheKey = `hero:${year}-${month}-${day}`

    // Expire the entry at the next HERO_TIMEZONE midnight, when the day key
    // rolls over anyway, instead of recomputing every fixed TTL all day.
    const payload = await cachedQuery(cacheKey, secondsUntilHeroMidnight(now), async () => {
      const candidates = await fetchHeroCandidates()
      const pick = pickDailyHero(candidates, now)
      if (!pick) {
        apiLogger.warn('hero: no eligible film for today\'s angle')
        return null
      }

      if (pick.usedFallback) {
        apiLogger.warn(
          { angle: pick.angle.label },
          'hero: no-repeat guard emptied the pool, fell back to the eligible set',
        )
      }

      // Stamp the pick, fire-and-forget. The response returns the same film
      // regardless of whether this commits, because selection did not depend
      // on lastFeaturedAt beyond the day-granular guard.
      stampHeroFeatured(pick.film.id, now).catch((err) =>
        apiLogger.error({ err, filmId: pick.film.id }, 'hero: stamp failed'),
      )

      const film = await prisma.film.findUnique({
        where: { id: pick.film.id },
        include: {
          sentimentGraph: {
            select: {
              overallScore: true,
              dataPoints: true,
              biggestSwing: true,
              peakMoment: true,
              lowestMoment: true,
              arcShape: true,
            },
          },
        },
      })
      if (!film) return null

      return {
        film: withDerivedFields(film),
        angle: pick.angle,
        usedFallback: pick.usedFallback,
      }
    })

    if (!payload) {
      return Response.json({ film: null, angle: null }, { status: 200 })
    }

    // Best-effort session, like the detail route: any auth failure means the
    // request proceeds as anonymous rather than 500ing a public endpoint.
    let userId: string | null = null
    try {
      const session = await getMobileOrServerSession()
      userId = session?.user?.id ?? null
    } catch {
      // Auth failure on a public endpoint is non-fatal.
    }

    // Per-user merge AFTER the cache read, on fresh objects only: the flag
    // must never reach the shared Redis payload, so never assign onto
    // `payload` or `payload.film`. Enriched responses are per-user and must
    // not be cached by any shared layer; anonymous responses keep today's
    // headers untouched.
    if (userId && payload.film) {
      const row = await prisma.userReview.findUnique({
        where: { userId_filmId: { userId, filmId: payload.film.id } },
        select: { id: true },
      })
      return Response.json(
        { ...payload, film: { ...payload.film, userHasReviewed: Boolean(row) } },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    return Response.json(payload)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to pick daily hero')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
