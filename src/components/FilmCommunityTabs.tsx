'use client'

import { useState } from 'react'
import UserReviewSection from './UserReviewSection'
import LiveReactionSection from './LiveReactionSection'

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
  const [tab, setTab] = useState<'review' | 'react'>('review')

  return (
    <div>
      {/* Tab Headers */}
      <div className="flex border-b border-cinema-border mb-6">
        <button
          onClick={() => setTab('review')}
          className="px-6 py-3 text-sm font-medium transition-all duration-200 relative"
          style={{
            color: tab === 'review' ? '#C8A951' : 'rgba(240,230,211,0.5)',
          }}
        >
          Write a Review
          {tab === 'review' && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cinema-gold" />
          )}
        </button>
        <button
          onClick={() => setTab('react')}
          className="px-6 py-3 text-sm font-medium transition-all duration-200 relative"
          style={{
            color: tab === 'react' ? '#C8A951' : 'rgba(240,230,211,0.5)',
          }}
        >
          ⚡ Live React
          {tab === 'react' && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cinema-gold" />
          )}
        </button>
      </div>

      {/* Tab Content */}
      {tab === 'review' ? (
        <UserReviewSection filmId={filmId} hasGraph={hasGraph} beats={beats} />
      ) : (
        <LiveReactionSection filmId={filmId} runtime={runtime} />
      )}
    </div>
  )
}
