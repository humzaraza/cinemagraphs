// Round-interval x-axis ruler for a film's runtime. timeMidpoint is an
// estimate (the sentiment pipeline midpoints equal buckets of the runtime; it
// does not observe timing), so a time axis marks round intervals rather than
// pairing a label with a beat, and no tick lands on the exact runtime; that
// would re-assert precision at the right edge that the data does not have.
// The share poster route and the on-page recharts graphs both draw from this
// module; the poster maps the minutes onto its own pixel coordinates, the
// recharts graphs consume the minute values directly.

const RULER_INTERVALS = [5, 10, 15, 30, 60, 120, 240]

export function hasRuntime(runtimeMin: number | null | undefined): runtimeMin is number {
  return typeof runtimeMin === 'number' && Number.isFinite(runtimeMin) && runtimeMin > 0
}

// 15-minute ticks under 90 minutes, 30-minute from there up; then step along
// the ladder while the tick count is outside 3..7 (clamped at the ends, so a
// short of under ~11 minutes can degenerate to fewer ticks).
export function rulerInterval(runtimeMin: number): number {
  let idx = RULER_INTERVALS.indexOf(runtimeMin < 90 ? 15 : 30)
  const tickCount = (interval: number) => Math.ceil(runtimeMin / interval)
  while (tickCount(RULER_INTERVALS[idx]) > 7 && idx < RULER_INTERVALS.length - 1) idx++
  while (tickCount(RULER_INTERVALS[idx]) < 3 && idx > 0) idx--
  return RULER_INTERVALS[idx]
}

export function formatRulerLabel(minutes: number): string {
  if (minutes === 0) return '0m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// Round-interval tick minutes in [0, runtimeMin). Empty when the runtime is
// unusable, so callers without one fall back instead of inventing a domain.
export function buildRulerMinutes(runtimeMin: number | null | undefined): number[] {
  if (!hasRuntime(runtimeMin)) return []
  const interval = rulerInterval(runtimeMin)
  const minutes: number[] = []
  for (let minute = 0; minute < runtimeMin; minute += interval) minutes.push(minute)
  return minutes
}

export interface NumericTimeAxis {
  domain: [number, number]
  ticks: number[]
}

// Numeric x-axis config for the recharts graphs: a [0, runtime] domain with
// the ruler's tick minutes. Null when the film has no usable runtime, which
// tells the caller to keep the categorical axis (one equal slot per beat);
// a domain invented from the last beat's midpoint would assert a runtime the
// data does not contain.
// The domain is a floor, not a clamp: with allowDataOverflow left false,
// recharts extends the axis to cover any beat midpoint past the runtime
// (possible when midpoints were generated against a defaulted runtime that
// was later backfilled). Deliberate: a drifted beat is drawn where its data
// says rather than clipped, at the cost of the ruler stopping short of the
// right edge on such films.
export function buildTimeAxis(runtimeMin: number | null | undefined): NumericTimeAxis | null {
  if (!hasRuntime(runtimeMin)) return null
  return { domain: [0, runtimeMin], ticks: buildRulerMinutes(runtimeMin) }
}

// Gradient-stop offset of the first measured beat inside the origin-fade
// mask. The mask runs in objectBoundingBox units of the drawn series, whose
// horizontal extent is the 0m origin row through the LAST beat's midpoint,
// not the axis domain, so on a numeric axis the first beat sits at
// firstMid / lastMid of the box; the runtime never enters into it. On the
// categorical fallback points are evenly spaced, putting the first beat at
// 1 / (rows - 1). Rows must begin with the 0m origin row; callers only use
// the offset when the origin is drawn.
export function originFadeOffset(
  rows: { timeMidpoint: number }[],
  numeric: boolean,
): number {
  if (rows.length < 2) return 0
  if (!numeric) return 1 / (rows.length - 1)
  const firstMid = rows[1].timeMidpoint
  const lastMid = rows[rows.length - 1].timeMidpoint
  return lastMid > 0 ? firstMid / lastMid : 0
}
