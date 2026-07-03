import { useEffect, useState } from 'react'

export type ReplyCountsMap = Record<string, number>

/**
 * Fetch reply counts for a set of reviews.
 *
 * Mirrors useReviewLikes: the request is keyed on the sorted, joined id list,
 * so it only re-runs when the actual set of ids changes, not on every render.
 * An empty id list skips the fetch entirely. Consumers read map[reviewId] and
 * default missing entries to 0.
 *
 * Failures are swallowed (console.warn only): the card links fall back to the
 * zero-count "Reply" label rather than crashing the page. Counts are public
 * and user-agnostic, but they change with every posted reply, so they live on
 * the client and never enter a cached server render.
 */
export function useReplyCounts(reviewIds: string[]): ReplyCountsMap {
  const [map, setMap] = useState<ReplyCountsMap>({})

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
        const res = await fetch('/api/reviews/replies/counts/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewIds: ids }),
        })
        if (!res.ok) {
          console.warn(`useReplyCounts: batch request failed (${res.status})`)
          return
        }
        const data = (await res.json()) as ReplyCountsMap
        if (!cancelled) {
          setMap(data)
        }
      } catch (err) {
        console.warn('useReplyCounts: batch request errored', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [key])

  return map
}
