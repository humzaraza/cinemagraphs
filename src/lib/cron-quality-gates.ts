export interface CronSkipCounts {
  total: number
  lowVotes: number
  lowPopularity: number
  excludedGenre: number
  noPoster: number
  shortRuntime: number
  noOverview: number
}

type SkipReason = Exclude<keyof CronSkipCounts, 'total'>

interface QualityGateMovie {
  vote_count?: number
  popularity?: number
  runtime?: number
  poster_path?: string
  overview?: string
  genres?: { id: number; name: string }[]
}

type GateResult = { pass: true } | { pass: false; reason: SkipReason }

const MIN_VOTES = 30
const MIN_POPULARITY = 15
const MIN_RUNTIME = 60
const EXCLUDED_GENRE_IDS = new Set([99, 10770]) // Documentary, TV Movie

export function checkCronQualityGates(movie: QualityGateMovie): GateResult {
  if (!movie.poster_path) {
    return { pass: false, reason: 'noPoster' }
  }

  if (!movie.overview) {
    return { pass: false, reason: 'noOverview' }
  }

  if ((movie.vote_count ?? 0) < MIN_VOTES) {
    return { pass: false, reason: 'lowVotes' }
  }

  if ((movie.popularity ?? 0) < MIN_POPULARITY) {
    return { pass: false, reason: 'lowPopularity' }
  }

  if ((movie.runtime ?? 0) < MIN_RUNTIME) {
    return { pass: false, reason: 'shortRuntime' }
  }

  if (movie.genres?.some((g) => EXCLUDED_GENRE_IDS.has(g.id))) {
    return { pass: false, reason: 'excludedGenre' }
  }

  return { pass: true }
}
