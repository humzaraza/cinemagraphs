import type { Prisma } from '@/generated/prisma/client'

/**
 * Safely extracts the per-slide backdrop URL override for a given
 * slide number from a draft's slideBackdropsJson column.
 *
 * Returns null if the JSON is null, is not a plain object, has no
 * entry for the slide, or the entry is not a string.
 *
 * Callers chain: resolvePerSlideBackdrop(json, n) ?? draftBackdropUrl ?? undefined
 */
export function resolvePerSlideBackdrop(
  slideBackdropsJson: Prisma.JsonValue | null | undefined,
  slideNumber: number,
): string | null {
  if (slideBackdropsJson == null) return null
  if (typeof slideBackdropsJson !== 'object' || Array.isArray(slideBackdropsJson)) {
    return null
  }
  const value = (slideBackdropsJson as Record<string, unknown>)[String(slideNumber)]
  return typeof value === 'string' ? value : null
}
