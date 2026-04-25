'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { tmdbImageUrl } from '@/lib/utils'

interface CastEntry {
  name: string
  slug: string
  character: string | null
  profilePath: string | null
}

export function FilmFullCast({ cast }: { cast: CastEntry[] }) {
  const [showAll, setShowAll] = useState(false)
  const INITIAL_COUNT = 20
  const visible = showAll ? cast : cast.slice(0, INITIAL_COUNT)
  const hasMore = cast.length > INITIAL_COUNT

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold">
          Full cast
        </h2>
        {hasMore && !showAll && (
          <span className="text-xs text-cinema-muted">
            Showing {INITIAL_COUNT} of {cast.length}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {visible.map((member) => {
          const initials = member.name
            .split(' ')
            .map((w) => w[0])
            .join('')
            .toUpperCase()
            .slice(0, 2)

          return (
            <Link
              key={`${member.slug}-${member.character}`}
              href={`/person/${member.slug}`}
              className="flex items-center gap-3 rounded-lg p-2 hover:bg-cinema-card/50 transition-colors"
            >
              {/* Profile photo */}
              <div className="flex-shrink-0 w-9 h-9 rounded-full overflow-hidden bg-cinema-darker relative">
                {member.profilePath ? (
                  <Image
                    src={tmdbImageUrl(member.profilePath, 'w45')}
                    alt={member.name}
                    fill
                    unoptimized
                    className="object-cover"
                    sizes="36px"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-cinema-muted text-[10px] font-bold">
                    {initials}
                  </div>
                )}
              </div>

              {/* Name + character */}
              <div className="min-w-0">
                <p className="text-sm text-cinema-teal truncate">{member.name}</p>
                {member.character && (
                  <p className="text-xs text-[#666] truncate">{member.character}</p>
                )}
              </div>
            </Link>
          )
        })}
      </div>

      {hasMore && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-4 text-sm text-cinema-gold hover:underline"
        >
          View all {cast.length} cast members
        </button>
      )}
    </div>
  )
}
