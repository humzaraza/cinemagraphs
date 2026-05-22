'use client'

import UserReviewSection, { type UserReviewSectionInitialData } from './UserReviewSection'
// import LiveReactionSection from './LiveReactionSection' // hidden — re-enable when ready

interface BeatInfo {
  label: string
  labelFull?: string
  score: number
}

interface Props {
  filmId: string
  hasGraph: boolean
  beats: BeatInfo[]
  beatSource: 'graph' | 'wiki' | 'none'
  runtime: number | null
  /** Page-1 reviews data from the detail page's server render; forwarded to UserReviewSection. */
  reviewsInitialData?: UserReviewSectionInitialData
}

export default function FilmCommunityTabs({
  filmId,
  hasGraph,
  beats,
  beatSource,
  runtime,
  reviewsInitialData,
}: Props) {
  return (
    <div>
      {/* Tab Headers */}
      <div className="flex border-b border-cinema-border mb-6">
        <button
          className="px-6 py-3 text-sm font-medium transition-all duration-200 relative"
          style={{
            color: 'var(--cinema-gold)',
          }}
        >
          Write a Review
          <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cinema-gold" />
        </button>
        {/* Live React tab hidden — re-enable when ready */}
      </div>

      {/* Tab Content */}
      <UserReviewSection
        filmId={filmId}
        hasGraph={hasGraph}
        beats={beats}
        beatSource={beatSource}
        initialData={reviewsInitialData}
      />
    </div>
  )
}
