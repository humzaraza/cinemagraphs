import { MIN_REVIEWS_TO_DISPLAY_GRAPH } from '@/lib/film-display-state'

export default function NotEnoughReviewsState({ reviewCount }: { reviewCount: number }) {
  return (
    <div className="rounded-lg border border-cinema-border bg-cinema-darker/40 px-6 py-16 md:py-20 text-center">
      <h2 className="font-[family-name:var(--font-playfair)] text-2xl md:text-3xl font-bold text-cinema-cream mb-3">
        Not enough reviews yet
      </h2>
      <p className="text-cinema-cream/80 max-w-lg mx-auto leading-relaxed">
        This film needs at least {MIN_REVIEWS_TO_DISPLAY_GRAPH} reviews to generate a sentiment graph.
        Be one of the first to review it.
      </p>
      <p className="text-sm text-cinema-cream/50 mt-3">
        {reviewCount} of {MIN_REVIEWS_TO_DISPLAY_GRAPH} reviews so far
      </p>
      <a
        href="#reviews"
        className="mt-8 inline-block bg-cinema-gold text-cinema-dark font-semibold px-6 py-2.5 rounded-lg hover:bg-cinema-gold/90 transition-colors"
      >
        Write a review
      </a>
    </div>
  )
}
