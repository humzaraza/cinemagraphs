import { prisma } from './prisma'
import { getPersonDetails } from './tmdb'
import { cacheDel, KEYS } from './cache'
import { logger } from './logger'

const bioLogger = logger.child({ module: 'person-bio' })

/**
 * tmdbFetch throws `Error('TMDB API error: <status> <statusText>')`. A 404 means
 * TMDB genuinely has no record for this person, which is permanent, so the
 * attempt should be marked and never retried. Any other failure (network, 5xx,
 * 429 rate limit) is transient and should be retried on a later view.
 */
function isTmdbNotFound(err: unknown): boolean {
  return err instanceof Error && /^TMDB API error: 404\b/.test(err.message)
}

/**
 * Stamp bioFetchedAt without writing any bio fields, and bust the shared cache
 * so the refreshed shape (marker set) is read next and no further backfill is
 * scheduled. Non-throwing: this runs in a fire-and-forget `after()` callback.
 */
async function markBioAttempted(tmdbPersonId: number): Promise<void> {
  try {
    await prisma.person.update({
      where: { tmdbPersonId },
      data: { bioFetchedAt: new Date() },
    })
    await cacheDel(KEYS.person(tmdbPersonId))
  } catch (err) {
    bioLogger.warn({ tmdbPersonId, err }, 'failed to mark bio attempted')
  }
}

/**
 * Fetch a person's biography/dates from TMDB and persist them, stamping
 * bioFetchedAt so the attempt is never repeated, even when TMDB returns an
 * empty bio. Pure write path: no request-scoped APIs, so it is safe to call
 * from an `after()` callback and from backfill scripts. Busts the shared
 * person:<id> cache so the next read repopulates with the new bio.
 *
 * Failure handling:
 *   - TMDB 404 (person absent in TMDB): stamp the marker so we never retry.
 *   - network / 5xx / 429 (transient): leave the marker null so a later view
 *     retries.
 * Non-throwing in all cases.
 */
export async function syncPersonBio(tmdbPersonId: number): Promise<void> {
  let tmdbPerson
  try {
    tmdbPerson = await getPersonDetails(tmdbPersonId)
  } catch (err) {
    if (isTmdbNotFound(err)) {
      await markBioAttempted(tmdbPersonId)
      bioLogger.info({ tmdbPersonId }, 'person absent in TMDB (404); marked bio attempted')
    } else {
      bioLogger.warn({ tmdbPersonId, err }, 'person bio backfill failed (transient); will retry')
    }
    return
  }

  try {
    await prisma.person.update({
      where: { tmdbPersonId },
      data: {
        biography: tmdbPerson.biography || null,
        birthday: tmdbPerson.birthday || null,
        deathday: tmdbPerson.deathday || null,
        // undefined leaves the existing value untouched when TMDB has none
        knownForDepartment: tmdbPerson.known_for_department || undefined,
        bioFetchedAt: new Date(),
      },
    })
    await cacheDel(KEYS.person(tmdbPersonId))
    bioLogger.info({ tmdbPersonId }, 'backfilled person bio')
  } catch (err) {
    bioLogger.warn({ tmdbPersonId, err }, 'person bio write failed')
  }
}
