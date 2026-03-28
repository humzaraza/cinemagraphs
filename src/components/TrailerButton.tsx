'use client'

import { useState } from 'react'
import TrailerModal from './TrailerModal'

export default function TrailerButton({ trailerKey }: { trailerKey: string }) {
  const [showModal, setShowModal] = useState(false)

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="inline-flex items-center gap-2 border border-white/60 text-white px-5 py-2.5 rounded-lg hover:border-cinema-gold hover:text-cinema-gold transition-colors text-sm"
      >
        <span className="text-xs">&#9654;</span>
        Watch Trailer
      </button>
      {showModal && (
        <TrailerModal trailerKey={trailerKey} onClose={() => setShowModal(false)} />
      )}
    </>
  )
}
