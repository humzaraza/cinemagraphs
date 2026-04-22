import type { SlideCopy } from './body-copy-generator'

export const HEADLINE_MAX = 80
export const HEADLINE_WARN = 70
export const BODY_SOFT_LIMIT = 300

// Hard-clip headline input to HEADLINE_MAX characters. The textarea uses this
// as an input filter so the field physically cannot exceed the server cap.
export function clampHeadline(input: string, max: number = HEADLINE_MAX): string {
  if (input.length <= max) return input
  return input.slice(0, max)
}

export type CounterState = 'neutral' | 'warn' | 'danger'

// Maps headline length to a visual state. The admin page uses this to pick a
// text color: muted under 70, gold at 70-79, red at 80 (the hard cap).
export function headlineCounterState(length: number, max: number = HEADLINE_MAX): CounterState {
  if (length >= max) return 'danger'
  if (length >= HEADLINE_WARN) return 'warn'
  return 'neutral'
}

export function bodyExceedsSoftLimit(text: string, limit: number = BODY_SOFT_LIMIT): boolean {
  return text.length > limit
}

export function slideCopyEqual(a: SlideCopy, b: SlideCopy): boolean {
  return a.pill === b.pill && a.headline === b.headline && a.body === b.body
}
