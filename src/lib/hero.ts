// Daily Explore hero pick. One film per day, the same for every user all day,
// deterministic from the calendar date alone.
//
// Determinism + the midnight race: lastFeaturedAt is a FILTER input only. It
// never affects which film is chosen from the eligible set beyond a coarse
// 14-day no-repeat guard, and that guard is DAY-GRANULAR and keeps a film
// featured *today* eligible (see the guard below). So stamping today's pick
// does not change today's eligible set, and the pick stays identical for every
// request all day, even on a cache miss or a concurrent first request. The
// stamp is therefore a harmless, idempotent side effect.

import { prisma } from './prisma'
import { computeSwingMagnitude } from './sentiment-metrics'
import type { ArcShape } from './arc-classifier'

// Controls the daily rollover boundary for the hero pick. Named so the
// boundary is discoverable rather than buried in a date call.
export const HERO_TIMEZONE = 'America/Toronto'

// Cap the ranked rotation pool so Monday/Tuesday do not show the same #1 film
// every week.
export const HERO_RANKED_POOL_SIZE = 30

export const HERO_NO_REPEAT_DAYS = 14
export const HERO_MIN_VOTES = 14
export const HERO_MIN_BEATS = 5 // a "real arc" worth featuring

type RankedMetric = 'overallScore' | 'swing'

export type HeroAngle =
  | { kind: 'ranked'; metric: RankedMetric; label: string }
  | { kind: 'shape'; shape: ArcShape; label: string }

// Day-of-week (0 = Sunday ... 6 = Saturday) to angle.
export function heroAngleForDayOfWeek(dayOfWeek: number): HeroAngle {
  switch (dayOfWeek) {
    case 1:
      return { kind: 'ranked', metric: 'overallScore', label: 'highest rated' }
    case 2:
      return { kind: 'ranked', metric: 'swing', label: 'biggest swing' }
    case 3:
      return { kind: 'shape', shape: 'hidden peak', label: 'hidden peak' }
    case 4:
      return { kind: 'shape', shape: 'nosedive', label: 'nosedive' }
    case 5:
      return { kind: 'shape', shape: 'perfect ending', label: 'perfect ending' }
    case 6:
      return { kind: 'shape', shape: 'slow burn', label: 'slow burn' }
    case 0:
    default:
      return { kind: 'shape', shape: 'steady great', label: 'steady great' }
  }
}

export type HeroDateParts = {
  year: number
  month: number
  day: number
  dayOfWeek: number // 0 = Sunday ... 6 = Saturday
  dayOfYear: number // 1-based ordinal day within the year
  dayNumber: number // absolute day index (days since epoch) for the local date
}

// Resolve an instant to its calendar parts in HERO_TIMEZONE. Using the local
// calendar date (not server TZ) keeps the daily boundary consistent and is
// DST-safe: we extract the local Y/M/D via Intl, then derive day-of-week /
// ordinal / absolute-day from that calendar date with UTC math.
export function heroDateParts(now: Date): HeroDateParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: HERO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = fmt.formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))

  const utcMidnight = Date.UTC(year, month - 1, day)
  const dayNumber = Math.floor(utcMidnight / 86_400_000)
  const dayOfWeek = new Date(utcMidnight).getUTCDay()
  const dayOfYear = Math.floor((utcMidnight - Date.UTC(year, 0, 1)) / 86_400_000) + 1

  return { year, month, day, dayOfWeek, dayOfYear, dayNumber }
}

// Lightweight per-film inputs the pick needs. The route builds these from the
// DB; tests build them directly.
export type HeroCandidate = {
  id: string
  imdbVotes: number | null
  beatCount: number
  overallScore: number
  swing: number
  arcShape: string[]
  lastFeaturedAt: Date | null
}

export type HeroPick = {
  film: HeroCandidate
  angle: HeroAngle
  usedFallback: boolean
}

function matchesAngle(c: HeroCandidate, angle: HeroAngle): boolean {
  // Ranked angles apply to every graphed film; the angle only sets the metric.
  if (angle.kind === 'ranked') return true
  return c.arcShape.includes(angle.shape)
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Deterministic selection from a non-empty eligible pool, given the angle and
 * today's ordinal day. Exported for direct testing.
 *
 * - Ranked angles: sort by the metric descending, film.id ascending as a
 *   stable tiebreaker, cap at HERO_RANKED_POOL_SIZE, then take
 *   dayOfYear % min(pool.length, HERO_RANKED_POOL_SIZE).
 * - Shape angles: no natural ranking, so sort by film.id ascending and take
 *   dayOfYear % pool.length.
 */
export function selectFromPool(
  pool: HeroCandidate[],
  angle: HeroAngle,
  dayOfYear: number,
): HeroCandidate {
  if (angle.kind === 'ranked') {
    const metric = angle.metric
    const sorted = [...pool].sort((a, b) => {
      const av = metric === 'swing' ? a.swing : a.overallScore
      const bv = metric === 'swing' ? b.swing : b.overallScore
      if (bv !== av) return bv - av
      return byId(a, b)
    })
    const capped = sorted.slice(0, HERO_RANKED_POOL_SIZE)
    return capped[dayOfYear % capped.length]
  }
  const sorted = [...pool].sort(byId)
  return sorted[dayOfYear % sorted.length]
}

/**
 * Pick today's hero. Pure function of (date, candidates). Returns null only
 * when no film matches today's angle at all.
 */
export function pickDailyHero(candidates: HeroCandidate[], now: Date): HeroPick | null {
  const { dayOfWeek, dayOfYear, dayNumber } = heroDateParts(now)
  const angle = heroAngleForDayOfWeek(dayOfWeek)

  const eligible = candidates.filter(
    (c) =>
      (c.imdbVotes ?? 0) >= HERO_MIN_VOTES &&
      c.beatCount >= HERO_MIN_BEATS &&
      matchesAngle(c, angle),
  )
  if (eligible.length === 0) return null

  // 14-day no-repeat guard, day-granular. A film featured TODAY (daysAgo 0)
  // stays eligible, so today's own stamp does not shrink today's set and the
  // pick stays stable for every request all day. Films featured 1..14 days ago
  // are excluded; 15+ days ago (or never) are kept.
  const guarded = eligible.filter((c) => {
    if (!c.lastFeaturedAt) return true
    const daysAgo = dayNumber - heroDateParts(c.lastFeaturedAt).dayNumber
    return daysAgo <= 0 || daysAgo > HERO_NO_REPEAT_DAYS
  })

  // Better to repeat than show nothing.
  const usedFallback = guarded.length === 0
  const pool = usedFallback ? eligible : guarded

  return { film: selectFromPool(pool, angle, dayOfYear), angle, usedFallback }
}

// ── DB helpers (not exercised by unit tests; hit the shared Neon DB) ─────────

/** Fetch the lightweight candidate set: ACTIVE films with enough votes and a
 *  graph. Beat count and swing are derived here so the pick stays pure. */
export async function fetchHeroCandidates(): Promise<HeroCandidate[]> {
  const films = await prisma.film.findMany({
    where: {
      status: 'ACTIVE',
      imdbVotes: { gte: HERO_MIN_VOTES },
      sentimentGraph: { isNot: null },
    },
    select: {
      id: true,
      imdbVotes: true,
      sentimentGraph: {
        select: {
          overallScore: true,
          arcShape: true,
          lastFeaturedAt: true,
          peakMoment: true,
          lowestMoment: true,
          dataPoints: true,
        },
      },
    },
  })

  return films.flatMap((f) => {
    const g = f.sentimentGraph
    if (!g) return []
    return [
      {
        id: f.id,
        imdbVotes: f.imdbVotes,
        beatCount: Array.isArray(g.dataPoints) ? g.dataPoints.length : 0,
        overallScore: g.overallScore,
        swing: computeSwingMagnitude(g.peakMoment, g.lowestMoment),
        arcShape: g.arcShape,
        lastFeaturedAt: g.lastFeaturedAt,
      },
    ]
  })
}

/** Stamp the chosen film as featured. Targeted update by filmId (unique), never
 *  a batch write. Idempotent: a later now() simply overwrites, which is
 *  harmless because the pick never depends on lastFeaturedAt beyond the
 *  day-granular guard. */
export async function stampHeroFeatured(filmId: string, when: Date): Promise<void> {
  await prisma.sentimentGraph.update({
    where: { filmId },
    data: { lastFeaturedAt: when },
  })
}
