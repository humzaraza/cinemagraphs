'use client'

import UserReviewSection from './UserReviewSection'
// import LiveReactionSection from './LiveReactionSection' // hidden — re-enable when ready

interface BeatInfo {
  label: string
  score: number
}

interface Props {
  filmId: string
  hasGraph: boolean
  beats: BeatInfo[]
  runtime: number | null
}

export default function FilmCommunityTabs({ filmId, hasGraph, beats, runtime }: Props) {
  return (
    <div>
      {/* Tab Headers */}
      <div className="flex border-b border-cinema-border mb-6">
        <button
          className="px-6 py-3 text-sm font-medium transition-all duration-200 relative"
          style={{
            color: '#C8A951',
          }}
        >
          Write a Review
          <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cinema-gold" />
        </button>
        {/* Live React tab hidden — re-enable when ready */}
      </div>

      {/* Tab Content */}
      <UserReviewSection filmId={filmId} hasGraph={hasGraph} beats={beats} />
    </div>
  )
}
