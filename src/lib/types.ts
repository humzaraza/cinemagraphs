// Sentiment data point stored in DB (JSON field) and used by components
export interface SentimentDataPoint {
  timeStart: number
  timeEnd: number
  timeMidpoint: number
  score: number
  label: string
  labelFull?: string
  confidence: 'low' | 'medium' | 'high'
  reviewEvidence: string
}

// Peak/lowest moment metadata
export interface PeakLowMoment {
  label: string
  labelFull?: string
  score: number
  time: number
}

// Mini graph data point (subset used by film cards)
export interface MiniGraphDataPoint {
  timeMidpoint?: number
  timeStart?: number
  timeEnd?: number
  score: number
}

// Fetched review before storing in DB
export interface FetchedReview {
  sourcePlatform: 'TMDB' | 'IMDB' | 'REDDIT' | 'CRITIC_BLOG' | 'LETTERBOXD' | 'GUARDIAN'
  sourceUrl: string | null
  author: string | null
  reviewText: string
  sourceRating: number | null
}

/**
 * Return shape for a single review-source fetcher. Lets the coordinator
 * distinguish "source is reachable but found nothing" from "source is
 * unreachable / misconfigured / quota-exhausted" so the pipeline summary
 * can report specific reasons for each failed source.
 */
export interface FetchResult {
  reviews: FetchedReview[]
  /** Whether the source was fully reachable and configured. A source that
   *  successfully returned 0 reviews is still `ok: true`. */
  ok: boolean
  /** Short human-readable failure reason for the summary line. Present when
   *  `ok` is false (e.g. "429 quota exceeded", "no API key"). */
  reason?: string
}

// Claude analysis output
export interface SentimentGraphData {
  film: string
  anchoredFrom: string
  dataPoints: SentimentDataPoint[]
  overallSentiment: number
  peakMoment: PeakLowMoment
  lowestMoment: PeakLowMoment
  biggestSentimentSwing: string
  summary: string
  sources: string[]
  varianceSource: 'external_only' | 'blended'
  reviewCount: number
  generatedAt: string
}

// Cast member from TMDB (stored as JSON in Film.cast)
export interface CastMember {
  name: string
  character: string
  profilePath?: string
}
