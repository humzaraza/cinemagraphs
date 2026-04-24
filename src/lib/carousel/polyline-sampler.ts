// Monotone cubic Hermite polyline sampler.
//
// The carousel graph is drawn by d3-shape's curveMonotoneX (Fritsch-Carlson
// monotone cubic Hermite). That curve has the useful property that Y is a
// well-defined function of X across its domain — so Y can be recovered
// directly from X without solving a parametric equation. This module
// reimplements d3-shape's tangent + segment math so the score-label picker
// can ask "what Y does the rendered polyline have at this X?"
//
// Tangent calculation matches d3-shape internals:
//   - interior point: (sign(s0)+sign(s1)) * min(|s0|, |s1|, 0.5*|p|)
//     where p = (s0*h1 + s1*h0) / (h0+h1)
//   - endpoint: (3*adjacent_slope - neighbor_tangent) / 2
// See d3-shape/src/curve/monotone.js.

export type SamplerPoint = { x: number; y: number }

function sgn(x: number): number {
  return x < 0 ? -1 : x > 0 ? 1 : 0
}

function interiorTangent(p0: SamplerPoint, p1: SamplerPoint, p2: SamplerPoint): number {
  const h0 = p1.x - p0.x
  const h1 = p2.x - p1.x
  if (h0 <= 0 || h1 <= 0) return 0
  const s0 = (p1.y - p0.y) / h0
  const s1 = (p2.y - p1.y) / h1
  const p = (s0 * h1 + s1 * h0) / (h0 + h1)
  const t = (sgn(s0) + sgn(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p))
  return Number.isFinite(t) ? t : 0
}

function endpointTangent(
  p0: SamplerPoint,
  p1: SamplerPoint,
  neighborTangent: number,
): number {
  const h = p1.x - p0.x
  if (h <= 0) return neighborTangent
  const s = (p1.y - p0.y) / h
  return (3 * s - neighborTangent) / 2
}

function computeTangents(points: SamplerPoint[]): number[] {
  const n = points.length
  if (n < 2) return n === 1 ? [0] : []
  if (n === 2) {
    const h = points[1].x - points[0].x
    const s = h <= 0 ? 0 : (points[1].y - points[0].y) / h
    return [s, s]
  }
  const tangents: number[] = new Array(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    tangents[i] = interiorTangent(points[i - 1], points[i], points[i + 1])
  }
  tangents[0] = endpointTangent(points[0], points[1], tangents[1])
  tangents[n - 1] = endpointTangent(points[n - 2], points[n - 1], tangents[n - 2])
  return tangents
}

function findSegment(points: SamplerPoint[], x: number): number {
  // Binary search for the segment [i, i+1] containing x. Assumes x is within
  // [points[0].x, points[n-1].x] (caller has range-checked).
  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (points[mid].x <= x) lo = mid
    else hi = mid
  }
  return lo
}

// Creates a reusable sampler for a given dot array. Tangents are computed
// once; each call is O(log n) for the binary search plus a constant-time
// Hermite evaluation.
export function makePolylineSampler(
  points: SamplerPoint[],
): (x: number) => number | null {
  if (points.length < 2) {
    return () => null
  }
  const tangents = computeTangents(points)
  const first = points[0]
  const last = points[points.length - 1]
  return (x: number) => {
    if (!Number.isFinite(x)) return null
    if (x < first.x || x > last.x) return null
    const i = findSegment(points, x)
    const p0 = points[i]
    const p1 = points[i + 1]
    const h = p1.x - p0.x
    if (h <= 0) return (p0.y + p1.y) / 2
    const t = (x - p0.x) / h
    const t2 = t * t
    const t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1
    const h10 = t3 - 2 * t2 + t
    const h01 = -2 * t3 + 3 * t2
    const h11 = t3 - t2
    return h00 * p0.y + h10 * h * tangents[i] + h01 * p1.y + h11 * h * tangents[i + 1]
  }
}

// Convenience wrapper matching the signature spec'd in the phase prompt.
// Use makePolylineSampler if you'll sample the same polyline repeatedly.
export function samplePolyline(x: number, points: SamplerPoint[]): number | null {
  return makePolylineSampler(points)(x)
}
