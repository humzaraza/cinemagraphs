import { useEffect, useState } from 'react'

export interface ReviewLikeInfo {
  count: number
  liked: boolean
}

export type ReviewLikesMap = Record<string, ReviewLikeInfo>

/**
 * Fetch like counts and the viewer's liked state for a set of reviews.
 *
 * The request is keyed on the sorted, joined id list, so it only re-runs when
 * the actual set of ids changes, not on every render. An empty id list skips
 * the fetch entirely. Consumers read map[reviewId] and default missing entries
 * to { count: 0, liked: false }.
 *
 * Failures are swallowed (console.warn only): the hearts stay at their defaults
 * rather than crashing the page. This is a per-user, non-cacheable read, so it
 * lives on the client and never enters a server render.
 */
export function useReviewLikes(reviewIds: string[]): ReviewLikesMap {
  const [map, setMap] = useState<ReviewLikesMap>({})

  // Stable key: sorting means [a,b] and [b,a] do not trigger a refetch.
  const key = [...reviewIds].sort().join(',')

  useEffect(() => {
    if (!key) {
      // No ids to look up; drop any stale entries.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the derived cache when the id set empties
      setMap({})
      return
    }

    let cancelled = false
    const ids = key.split(',')

    ;(async () => {
      try {
        const res = await fetch('/api/reviews/likes/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewIds: ids }),
        })
        if (!res.ok) {
          console.warn(`useReviewLikes: batch request failed (${res.status})`)
          return
        }
        const data = (await res.json()) as ReviewLikesMap
        if (!cancelled) {
          setMap(data)
        }
      } catch (err) {
        console.warn('useReviewLikes: batch request errored', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [key])

  return map
}
