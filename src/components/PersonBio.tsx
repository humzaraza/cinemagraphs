'use client'

import { useState } from 'react'

export function PersonBio({ biography }: { biography: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = biography.length > 300

  return (
    <div className="mt-3">
      <p
        className={`text-cinema-cream/80 text-sm leading-relaxed ${
          !expanded && isLong ? 'line-clamp-3' : ''
        }`}
      >
        {biography}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-cinema-gold text-sm mt-1 hover:underline"
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  )
}
