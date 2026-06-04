// Derived sentiment metrics computed at read time from precomputed fields.
// Kept in one place so the films API swing sort and the daily hero pick agree.

/**
 * Swing magnitude: how far sentiment travels between its peak and its low,
 * i.e. abs(peakMoment.score - lowestMoment.score). Computed from the
 * precomputed peakMoment / lowestMoment JSON (PeakLowMoment), never stored as
 * its own column, so it can't desync from the values it derives from.
 *
 * Returns 0 when either moment is missing or malformed, so callers can sort or
 * compare without null-guarding every row.
 */
export function computeSwingMagnitude(peakMoment: unknown, lowestMoment: unknown): number {
  const peak = momentScore(peakMoment)
  const low = momentScore(lowestMoment)
  if (peak === null || low === null) return 0
  return Math.abs(peak - low)
}

function momentScore(moment: unknown): number | null {
  if (moment && typeof moment === 'object' && 'score' in moment) {
    const score = (moment as { score: unknown }).score
    if (typeof score === 'number' && Number.isFinite(score)) return score
  }
  return null
}
