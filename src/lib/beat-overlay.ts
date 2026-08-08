// Geometry for the review beat overlay graphs: the film's sentiment arc in
// gold with the reviewer's beat ratings overlaid in teal. Pure path math so
// the review page (server) and profile page (client) render identically.

export interface BeatOverlayGeometry {
  width: number
  height: number
  padding: number
}

export interface BeatOverlayPaths {
  goldPath: string
  ratedRuns: string[]
  dots: { x: number; y: number }[]
  ratedCount: number
  totalBeats: number
}

/**
 * Builds the svg paths for a beat overlay graph.
 *
 * The gold path spans every data point continuously. The teal overlay only
 * connects runs of two or more consecutive rated beats; a gap in the indices
 * ends the run, so the line never asserts ratings the reviewer never gave.
 * Every rated beat gets a dot, whether it sits inside a run or alone.
 *
 * x is keyed on the index into dataPoints, never into the rated subset, so a
 * beat keeps its position in time regardless of which neighbours were rated.
 */
export function buildBeatOverlay(
  dataPoints: { label: string; score: number }[],
  beatRatings: Record<string, number> | null,
  geometry: BeatOverlayGeometry
): BeatOverlayPaths {
  const { width, height, padding } = geometry
  const xAt = (i: number) =>
    padding + (i / Math.max(dataPoints.length - 1, 1)) * (width - padding * 2)
  const yAt = (value: number) =>
    height - padding - ((value - 1) / 9) * (height - padding * 2)

  const goldPath = dataPoints
    .map((dp, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(dp.score)}`)
    .join(' ')

  const rated: { index: number; x: number; y: number }[] = []
  if (beatRatings) {
    dataPoints.forEach((dp, i) => {
      const rating = beatRatings[dp.label]
      if (typeof rating !== 'number') return
      rated.push({ index: i, x: xAt(i), y: yAt(rating) })
    })
  }

  const toPath = (run: { x: number; y: number }[]) =>
    run.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')

  const ratedRuns: string[] = []
  let run: { x: number; y: number }[] = []
  let prevIndex = Number.NaN
  for (const beat of rated) {
    if (run.length > 0 && beat.index !== prevIndex + 1) {
      if (run.length >= 2) ratedRuns.push(toPath(run))
      run = []
    }
    run.push(beat)
    prevIndex = beat.index
  }
  if (run.length >= 2) ratedRuns.push(toPath(run))

  return {
    goldPath,
    ratedRuns,
    dots: rated.map(({ x, y }) => ({ x, y })),
    ratedCount: rated.length,
    totalBeats: dataPoints.length,
  }
}
