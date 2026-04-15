// Shared y-axis scaling for sentiment sparklines.
// Same rule used by the share/review OG route and the main sentiment graphs:
// floor one whole number below the lowest data point, ceiling always 10.

export interface SparklineRange {
  yMin: number
  yMax: number
  yMid: number
}

export function computeSparklineRange(scores: readonly number[]): SparklineRange {
  const yMax = 10
  if (scores.length === 0) {
    return { yMin: 0, yMax, yMid: 5 }
  }
  const minScore = Math.min(...scores)
  const yMin = Math.max(0, Math.floor(minScore) - 1)
  return { yMin, yMax, yMid: (yMin + yMax) / 2 }
}
