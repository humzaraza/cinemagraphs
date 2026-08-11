// Geometry for the review beat overlay graphs: the film's sentiment arc in
// gold with the reviewer's beat ratings overlaid in teal. Pure path math so
// the review page (server), profile page (client), and share-image route
// render from one source of truth.

export interface BeatOverlaySidePadding {
  top: number
  right: number
  bottom: number
  left: number
}

export interface BeatOverlayGeometry {
  width: number
  height: number
  /** Uniform padding on all four sides. */
  padding: number
  /** Score mapped to the bottom of the drawable area. Defaults to 1. */
  yFloor?: number
  /** Score mapped to the top of the drawable area. Defaults to 10. */
  yCeiling?: number
  /**
   * When a positive finite number AND every dataPoint carries a finite
   * numeric timeMidpoint, x is timeMidpoint as a fraction of this runtime,
   * clamped to the drawable range. Otherwise x falls back to index spacing.
   */
  runtimeMinutes?: number
}

/**
 * Same geometry with per-side padding. A separate type (rather than a union
 * on the padding field) so existing callers can keep doing arithmetic on a
 * plain-number padding.
 */
export interface BeatOverlaySidePaddingGeometry extends Omit<BeatOverlayGeometry, 'padding'> {
  padding: BeatOverlaySidePadding
}

export interface BeatOverlayPaths {
  goldPath: string
  ratedRuns: string[]
  /**
   * Consecutive-run grouping of the rated beats as point arrays, including
   * runs of one. ratedRuns is derived from this: each run of two or more,
   * rendered as a path string.
   */
  runs: { x: number; y: number }[][]
  dots: { x: number; y: number }[]
  ratedCount: number
  totalBeats: number
}

export interface BeatOverlayDataPoint {
  label: string
  score: number
  timeMidpoint?: number
}

/**
 * Consecutive-run grouping of the rated beats as index arrays, including
 * runs of one. A rating only counts when its label matches a dataPoint and
 * its value is a number; a gap in the indices ends the run. This is the one
 * place the run rule lives: buildBeatOverlay maps these index runs to
 * points, and hasDrawableArc reads their lengths.
 */
function ratedIndexRuns(
  dataPoints: BeatOverlayDataPoint[],
  beatRatings: Record<string, number> | null | undefined
): number[][] {
  const runs: number[][] = []
  if (!beatRatings) return runs
  let run: number[] = []
  dataPoints.forEach((dp, i) => {
    if (typeof beatRatings[dp.label] !== 'number') return
    if (run.length > 0 && i !== run[run.length - 1] + 1) {
      runs.push(run)
      run = []
    }
    run.push(i)
  })
  if (run.length > 0) runs.push(run)
  return runs
}

/**
 * Whether the review has at least one drawable run: two or more rated beats
 * at adjacent indices in dataPoints. Geometry never changes the answer, so
 * none is taken; this is the shareability rule for a review's overlay.
 */
export function hasDrawableArc(
  dataPoints: BeatOverlayDataPoint[] | null | undefined,
  beatRatings: Record<string, number> | null | undefined
): boolean {
  if (!dataPoints) return false
  return ratedIndexRuns(dataPoints, beatRatings).some((run) => run.length >= 2)
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
 * When the geometry carries a usable runtime and every dataPoint a finite
 * timeMidpoint, x comes from the beat's true position in the runtime instead
 * of even index spacing.
 */
export function buildBeatOverlay(
  dataPoints: BeatOverlayDataPoint[],
  beatRatings: Record<string, number> | null,
  geometry: BeatOverlayGeometry | BeatOverlaySidePaddingGeometry
): BeatOverlayPaths {
  const { width, height, padding } = geometry
  const pad: BeatOverlaySidePadding =
    typeof padding === 'number'
      ? { top: padding, right: padding, bottom: padding, left: padding }
      : padding
  const yFloor = geometry.yFloor ?? 1
  const yCeiling = geometry.yCeiling ?? 10
  // Parenthesized so uniform padding stays bit-identical to the historical
  // `width - padding * 2`: p + p is exact in IEEE 754, (width - p) - p is not.
  const drawW = width - (pad.left + pad.right)
  const drawH = height - (pad.top + pad.bottom)

  const runtimeMinutes = geometry.runtimeMinutes
  const timeBased =
    typeof runtimeMinutes === 'number' &&
    Number.isFinite(runtimeMinutes) &&
    runtimeMinutes > 0 &&
    dataPoints.every(
      (dp) => typeof dp.timeMidpoint === 'number' && Number.isFinite(dp.timeMidpoint)
    )

  const xAt = (i: number) => {
    if (timeBased) {
      const fraction = (dataPoints[i].timeMidpoint as number) / (runtimeMinutes as number)
      return pad.left + Math.min(Math.max(fraction, 0), 1) * drawW
    }
    return pad.left + (i / Math.max(dataPoints.length - 1, 1)) * drawW
  }
  const yAt = (value: number) =>
    height - pad.bottom - ((value - yFloor) / (yCeiling - yFloor)) * drawH

  const goldPath = dataPoints
    .map((dp, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(dp.score)}`)
    .join(' ')

  const ratings = beatRatings ?? {}
  const pointAt = (i: number) => ({ x: xAt(i), y: yAt(ratings[dataPoints[i].label]) })
  const runs = ratedIndexRuns(dataPoints, beatRatings).map((run) => run.map(pointAt))

  const toPath = (run: { x: number; y: number }[]) =>
    run.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')

  const ratedRuns = runs.filter((r) => r.length >= 2).map(toPath)
  const dots = runs.flat().map(({ x, y }) => ({ x, y }))

  return {
    goldPath,
    ratedRuns,
    runs,
    dots,
    ratedCount: dots.length,
    totalBeats: dataPoints.length,
  }
}
