/**
 * Shared review-quality filter.
 *
 * Dependency-free by design: this module must NOT import prisma, claude, omdb,
 * the sentiment pipeline, or anything heavy, so lightweight scripts can pull in
 * isQualityReview without dragging the pipeline's transitive graph into startup.
 *
 * Canonical home for ENGLISH_REGEX, MIN_WORD_COUNT, and isQualityReview, which
 * were previously duplicated verbatim across the pipeline, two admin routes, and
 * several scripts.
 */

// ── Review quality filter ──

export const ENGLISH_REGEX = /^[\x00-\x7F\u00A0-\u024F\u2018-\u201D\u2014\u2013\u2026\s.,;:!?'"()\-[\]{}@#$%^&*+=/<>~`|\\]+$/
export const MIN_WORD_COUNT = 50

export function isQualityReview(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (words.length < MIN_WORD_COUNT) return false
  // Check if predominantly English/Latin characters
  if (!ENGLISH_REGEX.test(text.slice(0, 500))) return false
  return true
}
