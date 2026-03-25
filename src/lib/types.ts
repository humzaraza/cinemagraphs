// Sentiment data point stored in DB (JSON field) and used by components
export interface SentimentDataPoint {
  timeStart: number
  timeEnd: number
  timeMidpoint: number
  score: number
  label: string
  confidence: 'low' | 'medium' | 'high'
  reviewEvidence: string
}

// Peak/lowest moment metadata
export interface PeakLowMoment {
  label: string
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
