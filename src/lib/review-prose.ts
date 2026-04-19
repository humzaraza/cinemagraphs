export interface ReviewProseSections {
  beginning?: string | null
  middle?: string | null
  ending?: string | null
  otherThoughts?: string | null
}

export function formatReviewProse(review: ReviewProseSections): string {
  return [review.beginning, review.middle, review.ending, review.otherThoughts]
    .filter((section): section is string => typeof section === 'string' && section.trim().length > 0)
    .join('\n\n')
}
