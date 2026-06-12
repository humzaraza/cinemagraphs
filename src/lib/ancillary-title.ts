/**
 * Title-based exclusion for ancillary/bonus content: making-of and
 * behind-the-scenes featurettes, DVD extras, gag reels, storyboard reels.
 * These are movie-adjacent records on TMDB, not films, and they slip past
 * the genre gates because TMDB classifies them as Documentary, which the
 * studio bulk import deliberately allows.
 *
 * The patterns are deliberately narrow so REAL documentaries (March of the
 * Penguins, Free Solo, The Act of Killing) never match. If a pattern ever
 * catches a real documentary, it is too broad and must be tightened, not
 * worked around. See src/__tests__/ancillary-title.test.ts for the
 * guard-rail list.
 */
const ANCILLARY_TITLE_PATTERNS: RegExp[] = [
  /\bmaking of\b/i,
  /\bthe makings of\b/i,
  /\bbehind the scenes\b/i,
  /\bmarvel studios assembled\b/i,
  /\bfeaturettes?\b/i,
  /\bdeleted scenes?\b/i,
  /\bgag reels?\b/i,
  /\bbloopers?\b/i,
  /\bb-roll\b/i,
  /\bstoryboards?\b/i,
  /\bdvd extras?\b/i,
  /\bbonus features?\b/i,
  /\bextended preview\b/i,
]

export function isAncillaryTitle(title: string): boolean {
  return ANCILLARY_TITLE_PATTERNS.some((p) => p.test(title))
}

/** Which pattern matched, for logging/audit. Null when none did. */
export function matchedAncillaryPattern(title: string): string | null {
  const matched = ANCILLARY_TITLE_PATTERNS.find((p) => p.test(title))
  return matched ? matched.source : null
}
