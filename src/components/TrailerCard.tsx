'use client'

import { useState } from 'react'
import Image from 'next/image'
import { tmdbImageUrl } from '@/lib/utils'
import TrailerModal from './TrailerModal'

interface TrailerCardProps {
  title: string
  genres: string[]
  backdropUrl: string
  trailerKey: string
}

export default function TrailerCard({ title, genres, backdropUrl, trailerKey }: TrailerCardProps) {
  const [showModal, setShowModal] = useState(false)

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="group relative rounded-xl overflow-hidden aspect-video w-full text-left"
      >
        <Image
          src={tmdbImageUrl(backdropUrl, 'w780')}
          alt={title}
          fill
          unoptimized
          className="object-cover group-hover:scale-105 transition-transform duration-500"
          sizes="(max-width: 768px) 100vw, 33vw"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        {/* Play button */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-16 h-16 rounded-full bg-cinema-gold/90 flex items-center justify-center group-hover:bg-cinema-gold group-hover:scale-110 transition-all duration-300 shadow-xl">
            <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7 ml-1">
              <path d="M8 5v14l11-7L8 5z" fill="var(--cinema-dark)" />
            </svg>
          </div>
        </div>
        {/* Title overlay */}
        <div className="absolute bottom-0 left-0 right-0 p-4">
          <h3 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-white leading-tight">
            {title}
          </h3>
          {genres.length > 0 && (
            <p className="text-xs text-cinema-muted mt-1">
              {genres.slice(0, 3).join(' / ')}
            </p>
          )}
        </div>
      </button>
      {showModal && (
        <TrailerModal trailerKey={trailerKey} onClose={() => setShowModal(false)} />
      )}
    </>
  )
}
