/**
 * Validation + normalization helpers for banner-related API payloads.
 *
 * BACKDROP bannerValue persistence shape (PR 1c onward):
 *   JSON.stringify({ filmId: string, backdropPath: string | null })
 *
 * Stored as JSON-encoded string in the existing `User.bannerValue` String
 * column. No Prisma schema change. When `backdropPath === null`, the
 * client renders the Film's default `backdropUrl` (PR 1b behavior). When
 * `backdropPath` is a non-empty string starting with '/', the client
 * renders that specific TMDB backdrop.
 *
 * The PATCH endpoint accepts BOTH:
 *   - legacy plain-string filmId (pre-PR-1c clients): normalized to
 *     { filmId: <value>, backdropPath: null }
 *   - new object shape (PR-1c+ clients): validated and persisted as-is.
 *
 * After the data migration runs in production, every DB row is in the
 * new JSON shape. The dual-shape acceptance remains for backwards
 * compatibility with mobile builds in the wild that still send the
 * legacy plain-string filmId.
 */

export interface BackdropBannerValue {
  filmId: string
  backdropPath: string | null
}

export type BackdropParseResult =
  | { ok: true; value: BackdropBannerValue }
  | { ok: false; error: string }

/**
 * Normalize a BACKDROP bannerValue payload into the canonical
 * { filmId, backdropPath } object. Does NOT verify the filmId exists
 * in the catalog. Caller is responsible for that check.
 *
 * Accepts three input shapes:
 *   1. JS object { filmId, backdropPath } - new PATCH request body
 *   2. JSON-encoded string of the above object - the DB-stored shape
 *      after PR 1c (post-migration)
 *   3. Plain filmId string (legacy) - pre-PR-1c clients still in the
 *      wild and pre-migration DB rows
 *
 * The string heuristic: any string starting with '{' is treated as the
 * JSON-encoded shape and JSON.parse'd. A parse failure on such input
 * is treated as malformed (returns ok:false) rather than falling
 * through to legacy interpretation, so callers can fall back safely
 * (e.g., the profile renderer collapses to a default gradient).
 */
export function parseBackdropBannerValue(input: unknown): BackdropParseResult {
  if (typeof input === 'string') {
    if (input.length === 0) {
      return { ok: false, error: 'BACKDROP bannerValue string must be non-empty.' }
    }
    if (input.startsWith('{')) {
      try {
        return parseBackdropBannerValue(JSON.parse(input))
      } catch {
        return { ok: false, error: 'BACKDROP bannerValue: malformed JSON.' }
      }
    }
    return { ok: true, value: { filmId: input, backdropPath: null } }
  }

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      error:
        'BACKDROP bannerValue must be either a filmId string or an object { filmId, backdropPath }.',
    }
  }

  const obj = input as Record<string, unknown>
  const { filmId, backdropPath } = obj

  if (typeof filmId !== 'string' || filmId.length === 0) {
    return { ok: false, error: 'BACKDROP bannerValue.filmId must be a non-empty string.' }
  }

  if (backdropPath === null || backdropPath === undefined) {
    return { ok: true, value: { filmId, backdropPath: null } }
  }

  if (typeof backdropPath !== 'string') {
    return {
      ok: false,
      error: 'BACKDROP bannerValue.backdropPath must be null or a non-empty string starting with "/".',
    }
  }

  if (backdropPath.length === 0 || !backdropPath.startsWith('/')) {
    return {
      ok: false,
      error: 'BACKDROP bannerValue.backdropPath must be null or a non-empty string starting with "/".',
    }
  }

  return { ok: true, value: { filmId, backdropPath } }
}

/**
 * Encode a normalized BACKDROP bannerValue for storage in the
 * User.bannerValue String column.
 */
export function encodeBackdropBannerValue(value: BackdropBannerValue): string {
  return JSON.stringify(value)
}
