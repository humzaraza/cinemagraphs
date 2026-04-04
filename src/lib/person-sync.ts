import { prisma } from './prisma'
import { getMovieCredits } from './tmdb'
import { cacheDel, KEYS } from './cache'
import { logger } from './logger'

const syncLogger = logger.child({ module: 'person-sync' })

const CREW_JOB_MAP: Record<string, string> = {
  'Director': 'DIRECTOR',
  'Director of Photography': 'CINEMATOGRAPHER',
  'Cinematography': 'CINEMATOGRAPHER',
  'Original Music Composer': 'COMPOSER',
  'Music': 'COMPOSER',
  'Editor': 'EDITOR',
  'Screenplay': 'WRITER',
  'Writer': 'WRITER',
  'Story': 'WRITER',
  'Producer': 'PRODUCER',
  'Executive Producer': 'PRODUCER',
}

export function generatePersonSlug(name: string, tmdbPersonId: number): string {
  const nameSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${nameSlug}-${tmdbPersonId}`
}

interface PersonEntry {
  tmdbPersonId: number
  name: string
  profilePath: string | null
  knownForDepartment: string | null
  role: string
  character: string | null
  order: number | null
}

/**
 * Sync Person and FilmPerson records for a film from TMDB credits.
 * Non-throwing: logs errors but never fails the parent operation.
 */
export async function syncFilmCredits(filmId: string, tmdbId: number): Promise<void> {
  try {
    const credits = await getMovieCredits(tmdbId)

    const entries: PersonEntry[] = []

    // Cast (all entries)
    for (const member of (credits.cast as any[])) {
      entries.push({
        tmdbPersonId: member.id ?? member.tmdb_id,
        name: member.name,
        profilePath: member.profile_path ?? null,
        knownForDepartment: member.known_for_department ?? null,
        role: 'ACTOR',
        character: member.character || null,
        order: member.order ?? null,
      })
    }

    // Crew (filtered roles)
    for (const member of (credits.crew as any[])) {
      const role = CREW_JOB_MAP[member.job]
      if (!role) continue
      entries.push({
        tmdbPersonId: member.id ?? member.tmdb_id,
        name: member.name,
        profilePath: member.profile_path ?? null,
        knownForDepartment: member.known_for_department ?? null,
        role,
        character: null,
        order: null,
      })
    }

    // Deduplicate: same person + same role
    const seen = new Set<string>()
    const uniqueEntries = entries.filter((e) => {
      const key = `${e.tmdbPersonId}-${e.role}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    let castCount = 0
    let directorCount = 0
    let crewCount = 0
    const personTmdbIds = new Set<number>()

    for (const entry of uniqueEntries) {
      const slug = generatePersonSlug(entry.name, entry.tmdbPersonId)

      // Upsert Person — update profilePath but preserve existing bio fields
      try {
        await prisma.person.upsert({
          where: { tmdbPersonId: entry.tmdbPersonId },
          create: {
            name: entry.name,
            slug,
            tmdbPersonId: entry.tmdbPersonId,
            profilePath: entry.profilePath,
            knownForDepartment: entry.knownForDepartment,
          },
          update: {
            profilePath: entry.profilePath,
          },
        })
      } catch (err: any) {
        // Slug collision — try with a timestamp suffix
        if (err.code === 'P2002' && err.meta?.target?.includes('slug')) {
          await prisma.person.upsert({
            where: { tmdbPersonId: entry.tmdbPersonId },
            create: {
              name: entry.name,
              slug: `${slug}-${Date.now()}`,
              tmdbPersonId: entry.tmdbPersonId,
              profilePath: entry.profilePath,
              knownForDepartment: entry.knownForDepartment,
            },
            update: {
              profilePath: entry.profilePath,
            },
          })
        } else {
          throw err
        }
      }

      // Get person id
      const person = await prisma.person.findUnique({
        where: { tmdbPersonId: entry.tmdbPersonId },
        select: { id: true },
      })
      if (!person) continue

      personTmdbIds.add(entry.tmdbPersonId)

      // Create FilmPerson link (skip if exists)
      try {
        await prisma.filmPerson.create({
          data: {
            filmId,
            personId: person.id,
            role: entry.role as any,
            character: entry.character,
            order: entry.order,
          },
        })

        if (entry.role === 'ACTOR') castCount++
        else if (entry.role === 'DIRECTOR') directorCount++
        else crewCount++
      } catch (err: any) {
        if (err.code === 'P2002') continue // already exists
        throw err
      }
    }

    // Invalidate person cache for all affected persons
    const cacheKeys = Array.from(personTmdbIds).map((id) => KEYS.person(id))
    if (cacheKeys.length > 0) {
      await cacheDel(...cacheKeys)
    }

    syncLogger.info(
      { filmId, tmdbId, cast: castCount, directors: directorCount, crew: crewCount },
      'Synced credits',
    )
  } catch (err) {
    syncLogger.error({ filmId, tmdbId, err }, 'Failed to sync credits')
  }
}
