/**
 * One-time backlog drain for person biographies.
 *
 * Finds Person rows where the bio backfill has never been attempted
 * (biography IS NULL AND bioFetchedAt IS NULL), fetches each from TMDB, and
 * writes biography/birthday/deathday/knownForDepartment plus the bioFetchedAt
 * marker. This mirrors src/lib/person-bio.ts#syncPersonBio but runs standalone
 * (its own Prisma client, no Redis), draining the backlog so we do not rely
 * solely on organic page views to populate bios.
 *
 * Failure handling matches the app:
 *   - TMDB 404 (person absent in TMDB): stamp bioFetchedAt so it is never retried.
 *   - network / 5xx / 429 (transient): leave bioFetchedAt null so a re-run retries.
 *
 * This performs PRODUCTION WRITES against the shared Neon database. It is
 * intentionally not wired into any automation. Run manually only:
 *   npx tsx scripts/backfill-person-bios.ts
 */
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

const TMDB_API_KEY = process.env.TMDB_API_KEY!
if (!TMDB_API_KEY) {
  console.error('TMDB_API_KEY not found in environment')
  process.exit(1)
}
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

// Throttle TMDB calls to stay well under the rate limit.
const REQUEST_DELAY_MS = 30

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface TMDBPerson {
  biography: string
  birthday: string | null
  deathday: string | null
  known_for_department: string | null
}

class TmdbNotFoundError extends Error {}

async function fetchPersonDetails(tmdbPersonId: number): Promise<TMDBPerson> {
  const res = await fetch(`${TMDB_BASE_URL}/person/${tmdbPersonId}`, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
  })
  if (res.status === 404) {
    throw new TmdbNotFoundError(`TMDB 404 for person ${tmdbPersonId}`)
  }
  if (!res.ok) {
    throw new Error(`TMDB API error: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<TMDBPerson>
}

async function main() {
  const persons = await prisma.person.findMany({
    where: { biography: null, bioFetchedAt: null },
    select: { tmdbPersonId: true, name: true },
  })

  console.log(`Found ${persons.length} persons with no bio attempt yet.\n`)

  let withBio = 0
  let emptyBio = 0
  let notFound = 0
  let transientFailures = 0

  for (const person of persons) {
    try {
      const tmdb = await fetchPersonDetails(person.tmdbPersonId)
      await prisma.person.update({
        where: { tmdbPersonId: person.tmdbPersonId },
        data: {
          biography: tmdb.biography || null,
          birthday: tmdb.birthday || null,
          deathday: tmdb.deathday || null,
          knownForDepartment: tmdb.known_for_department || undefined,
          bioFetchedAt: new Date(),
        },
      })
      if (tmdb.biography) withBio++
      else emptyBio++
    } catch (err) {
      if (err instanceof TmdbNotFoundError) {
        // Permanent absence: stamp the marker so this person is never retried.
        await prisma.person.update({
          where: { tmdbPersonId: person.tmdbPersonId },
          data: { bioFetchedAt: new Date() },
        })
        notFound++
      } else {
        // Transient: leave bioFetchedAt null so a re-run retries this person.
        console.error(`  ✗ ${person.name} (${person.tmdbPersonId}): ${err}`)
        transientFailures++
      }
    }
    await sleep(REQUEST_DELAY_MS)
  }

  console.log('\n═══════════════════════════════════════════')
  console.log('           BIO BACKFILL COMPLETE')
  console.log('═══════════════════════════════════════════')
  console.log(`Persons processed:   ${persons.length}`)
  console.log(`With biography:      ${withBio}`)
  console.log(`Empty bio (marked):  ${emptyBio}`)
  console.log(`TMDB 404 (marked):   ${notFound}`)
  console.log(`Transient failures:  ${transientFailures}`)

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
