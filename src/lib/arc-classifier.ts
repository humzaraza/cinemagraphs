// Shared graph-shape math. Single home for both the marketing carousel's
// body-copy characteristics AND the persisted arc-shape classification, so the
// two never drift. The carousel generator and the sentiment write path both
// import from here.
//
// `computeCharacteristics` was moved verbatim from
// src/lib/carousel/body-copy-generator.ts (re-exported there for back-compat);
// its behaviour is unchanged.

import type { DataPoint } from './carousel/graph-renderer'

// ── Graph characteristics (carousel body-copy generator) ──────────────────

export type GraphCharacteristics = {
  dropSeverity: 'dramatic' | 'moderate' | 'mild'
  recoveryShape: 'sharp' | 'gradual' | 'none'
  peakHeight: number
  peakIsLate: boolean
  redDotCount: number
  endingDirection: 'up' | 'down' | 'flat'
}

export function computeCharacteristics(dataPoints: DataPoint[]): GraphCharacteristics {
  if (dataPoints.length === 0) {
    throw new Error('computeCharacteristics: dataPoints is empty')
  }

  let minIdx = 0
  let maxIdx = 0
  for (let i = 1; i < dataPoints.length; i++) {
    if (dataPoints[i].s < dataPoints[minIdx].s) minIdx = i
    if (dataPoints[i].s > dataPoints[maxIdx].s) maxIdx = i
  }
  const lowest = dataPoints[minIdx].s
  const peakHeight = dataPoints[maxIdx].s
  const peakTime = dataPoints[maxIdx].t
  const runtime = dataPoints[dataPoints.length - 1].t

  // dropSeverity: how far the lowest point dips.
  // < 4.0 → dramatic; < 6.0 → moderate (crosses the red-dot threshold); else mild.
  let dropSeverity: GraphCharacteristics['dropSeverity']
  if (lowest < 4.0) dropSeverity = 'dramatic'
  else if (lowest < 6.0) dropSeverity = 'moderate'
  else dropSeverity = 'mild'

  // recoveryShape: behaviour from the lowest beat forward.
  // sharp: next point after the low rises ≥ 2.0 within 15 minutes.
  // gradual: rises ≥ 1.0 above the low at some later point.
  // none: never rises ≥ 1.0, or the low is the final beat.
  let recoveryShape: GraphCharacteristics['recoveryShape'] = 'none'
  if (minIdx < dataPoints.length - 1) {
    let sharp = false
    let gradual = false
    for (let i = minIdx + 1; i < dataPoints.length; i++) {
      const delta = dataPoints[i].s - lowest
      const dt = dataPoints[i].t - dataPoints[minIdx].t
      if (delta >= 2.0 && dt <= 15) sharp = true
      if (delta >= 1.0) gradual = true
    }
    if (sharp) recoveryShape = 'sharp'
    else if (gradual) recoveryShape = 'gradual'
  }

  // peakIsLate: peak sits in the last 40% of runtime.
  const peakIsLate = runtime > 0 && peakTime >= runtime * 0.6

  // redDotCount: points strictly below 6.0.
  let redDotCount = 0
  for (const p of dataPoints) {
    if (p.s < 6.0) redDotCount++
  }

  // endingDirection: compare final beat to the first beat that falls inside
  // the last 15% of runtime. +0.5 → up, -0.5 → down, else flat.
  let endingDirection: GraphCharacteristics['endingDirection'] = 'flat'
  if (dataPoints.length >= 2 && runtime > 0) {
    const windowStart = runtime * 0.85
    let windowIdx = dataPoints.length - 1
    for (let i = 0; i < dataPoints.length; i++) {
      if (dataPoints[i].t >= windowStart) {
        windowIdx = i
        break
      }
    }
    const last = dataPoints[dataPoints.length - 1].s
    const first = dataPoints[windowIdx].s
    const delta = last - first
    if (delta >= 0.5) endingDirection = 'up'
    else if (delta <= -0.5) endingDirection = 'down'
  }

  return {
    dropSeverity,
    recoveryShape,
    peakHeight,
    peakIsLate,
    redDotCount,
    endingDirection,
  }
}

// ── Arc-shape classification ──────────────────────────────────────────────
//
// Persisted multi-tag classification of a film's sentiment arc. A film can
// carry several tags at once (overlap is intended: perfect ending + slow burn
// co-occur; hidden peak + nosedive co-occur). slow burn and nosedive are
// mutually exclusive by construction (net rise vs net fall).
//
// Every threshold is a named constant so backfill tuning needs no logic edits.
// All rules operate on dataPoints sorted ascending by timeMidpoint; the
// classifier sorts internally, because stored order is NOT guaranteed.

export const PERFECT_ENDING_ABOVE_MEAN = 1.0
export const SLOW_BURN_NET_RISE = 1.5
export const SLOW_BURN_MAX_DIP = 1.0 // largest allowed single-step drop
export const SLOW_BURN_MIN_RISING_RATIO = 0.6 // >= 60% of steps non-negative
export const SLOW_BURN_MAX_START = 7.2 // first beat must start at or below this
export const SLOW_BURN_MIN_ENDING = 7.5 // final beat must land at or above this
export const HIDDEN_PEAK_MIN_POS = 0.25 // peak position within beat-span
export const HIDDEN_PEAK_MAX_POS = 0.75
export const HIDDEN_PEAK_FALL_FROM_PEAK = 1.0 // final this far below peak
export const STEADY_GREAT_MIN_SCORE = 7.5
export const STEADY_GREAT_MAX_RANGE = 1.5 // peak - low
export const NOSEDIVE_NET_FALL = 1.5
export const NOSEDIVE_MAX_RISE = 1.0 // largest allowed single-step rise
export const NOSEDIVE_MIN_FALLING_RATIO = 0.6 // >= 60% of steps non-positive
export const NEAR_MAX_TOLERANCE = 0.3 // "first beat is at or near the max"

// Need at least 2 beats to have a first/final pair and one step. (The hero
// "real arc" bar of >= 5 beats is enforced separately at selection time.)
export const ARC_MIN_BEATS = 2

export type ArcShape =
  | 'slow burn'
  | 'hidden peak'
  | 'perfect ending'
  | 'steady great'
  | 'nosedive'

// Canonical order. classifyArcShape returns tags in this order so output is
// deterministic regardless of which rules fire.
export const ARC_SHAPES: readonly ArcShape[] = [
  'slow burn',
  'hidden peak',
  'perfect ending',
  'steady great',
  'nosedive',
] as const

// Minimal beat shape the classifier needs. SentimentDataPoint is structurally
// assignable to this, so callers pass their dataPoints directly.
export type ClassifierBeat = { timeMidpoint: number; score: number }

/**
 * Classify a film's sentiment arc into zero or more ArcShape tags.
 *
 * @param dataPoints beats (any order; sorted internally by timeMidpoint).
 * @param overallScore the graph's headline score (SentimentGraph.overallScore).
 *   Only steady great depends on it; pass null/undefined and steady great is
 *   simply never assigned, while the other four rules still apply.
 */
export function classifyArcShape(
  dataPoints: ClassifierBeat[],
  overallScore: number | null | undefined,
): ArcShape[] {
  // Defensive: drop any malformed beats (backfill reads raw JSON).
  const valid = dataPoints.filter(
    (b) => b && Number.isFinite(b.timeMidpoint) && Number.isFinite(b.score),
  )
  if (valid.length < ARC_MIN_BEATS) return []

  // REQUIRED: sort by timeMidpoint first. Stored order is not guaranteed.
  const beats = [...valid].sort((a, b) => a.timeMidpoint - b.timeMidpoint)
  const n = beats.length

  const first = beats[0]
  const final = beats[n - 1]

  let sum = 0
  for (const b of beats) sum += b.score
  const mean = sum / n

  // peak/low: highest/lowest score, earliest by timeMidpoint on ties. Because
  // beats are sorted ascending, the first strict extreme found is the earliest.
  let peakBeat = beats[0]
  let lowBeat = beats[0]
  for (const b of beats) {
    if (b.score > peakBeat.score) peakBeat = b
    if (b.score < lowBeat.score) lowBeat = b
  }

  const beatSpan = final.timeMidpoint - first.timeMidpoint
  const peakPosition = beatSpan > 0 ? (peakBeat.timeMidpoint - first.timeMidpoint) / beatSpan : null

  // Consecutive score deltas.
  const steps: number[] = []
  for (let i = 1; i < n; i++) steps.push(beats[i].score - beats[i - 1].score)
  const risingRatio = steps.filter((d) => d >= 0).length / steps.length
  const fallingRatio = steps.filter((d) => d <= 0).length / steps.length

  const tags: ArcShape[] = []

  // Slow burn: net rise, no big single dip, mostly rising, starting low enough
  // and ending high enough that the burn actually pays off. The ratio clause
  // keeps "flat with one late jump" from leaking in.
  if (
    final.score - first.score >= SLOW_BURN_NET_RISE &&
    !steps.some((d) => d < -SLOW_BURN_MAX_DIP) &&
    risingRatio >= SLOW_BURN_MIN_RISING_RATIO &&
    first.score <= SLOW_BURN_MAX_START &&
    final.score >= SLOW_BURN_MIN_ENDING
  ) {
    tags.push('slow burn')
  }

  // Hidden peak: peak sits in the middle of the runtime and the film comes down
  // off it by the end.
  if (
    peakPosition !== null &&
    peakPosition >= HIDDEN_PEAK_MIN_POS &&
    peakPosition <= HIDDEN_PEAK_MAX_POS &&
    peakBeat.score - final.score >= HIDDEN_PEAK_FALL_FROM_PEAK
  ) {
    tags.push('hidden peak')
  }

  // Perfect ending: final beat ties or exceeds every other beat, and sits well
  // above the mean. >= against the peak lets a final beat tied for highest
  // still qualify.
  if (final.score >= peakBeat.score && final.score - mean >= PERFECT_ENDING_ABOVE_MEAN) {
    tags.push('perfect ending')
  }

  // Steady great: high headline score with a tight band between peak and low.
  if (
    typeof overallScore === 'number' &&
    Number.isFinite(overallScore) &&
    overallScore >= STEADY_GREAT_MIN_SCORE &&
    peakBeat.score - lowBeat.score < STEADY_GREAT_MAX_RANGE
  ) {
    tags.push('steady great')
  }

  // Nosedive: opens at or near the max, then nets a big fall, no big single
  // rise, mostly falling.
  if (
    first.score >= peakBeat.score - NEAR_MAX_TOLERANCE &&
    first.score - final.score >= NOSEDIVE_NET_FALL &&
    !steps.some((d) => d > NOSEDIVE_MAX_RISE) &&
    fallingRatio >= NOSEDIVE_MIN_FALLING_RATIO
  ) {
    tags.push('nosedive')
  }

  return tags
}
