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

export interface QualityGateOptions {
  /**
   * Let Documentary (TMDB genre 99) through the gate. TV Movie (10770) is
   * always excluded regardless. Default false, which preserves the original
   * cron behavior: both genres excluded.
   */
  allowDocumentaries?: boolean
  /**
   * Skip the MIN_POPULARITY floor. TMDB popularity is a current-trending
   * metric, so the floor permanently rejects famous older films that simply
   * are not trending right now; one-shot archival imports skip it while the
   * cron (which evaluates new releases) keeps it. The vote floor still
   * filters junk. Default false, which preserves the original cron behavior.
   */
  skipPopularityCheck?: boolean
}

const MIN_VOTES = 30
const MIN_POPULARITY = 15
const MIN_RUNTIME = 60
const DOCUMENTARY_GENRE_ID = 99
const TV_MOVIE_GENRE_ID = 10770

export function checkCronQualityGates(
  movie: QualityGateMovie,
  options: QualityGateOptions = {}
): GateResult {
  if (!movie.poster_path) {
    return { pass: false, reason: 'noPoster' }
  }

  if (!movie.overview) {
    return { pass: false, reason: 'noOverview' }
  }

  if ((movie.vote_count ?? 0) < MIN_VOTES) {
    return { pass: false, reason: 'lowVotes' }
  }

  if (!options.skipPopularityCheck && (movie.popularity ?? 0) < MIN_POPULARITY) {
    return { pass: false, reason: 'lowPopularity' }
  }

  if ((movie.runtime ?? 0) < MIN_RUNTIME) {
    return { pass: false, reason: 'shortRuntime' }
  }

  const genreExcluded = movie.genres?.some(
    (g) =>
      g.id === TV_MOVIE_GENRE_ID ||
      (g.id === DOCUMENTARY_GENRE_ID && !options.allowDocumentaries)
  )
  if (genreExcluded) {
    return { pass: false, reason: 'excludedGenre' }
  }

  return { pass: true }
}
