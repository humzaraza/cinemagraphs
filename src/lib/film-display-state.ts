import type { SentimentGraph } from '@/generated/prisma/client'

export const MIN_REVIEWS_TO_DISPLAY_GRAPH = 3

export type FilmDisplayState =
  | { kind: 'graph'; sentimentGraph: SentimentGraph }
  | { kind: 'not_enough_reviews'; reviewCount: number }
  | { kind: 'coming_soon'; releaseDate: Date }

export function getFilmDisplayState(
  film: { releaseDate: Date | null },
  sentimentGraph: SentimentGraph | null,
  reviewCount: number
): FilmDisplayState {
  const now = new Date()

  if (film.releaseDate && film.releaseDate > now) {
    return { kind: 'coming_soon', releaseDate: film.releaseDate }
  }

  if (!sentimentGraph || reviewCount < MIN_REVIEWS_TO_DISPLAY_GRAPH) {
    return { kind: 'not_enough_reviews', reviewCount }
  }

  return { kind: 'graph', sentimentGraph }
}
