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

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

// ── Helpers ──────────────────────────────────────────────

function generatePersonSlug(name: string, tmdbPersonId: number): string {
  const nameSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${nameSlug}-${tmdbPersonId}`
}

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

interface TMDBCastMember {
  id: number
  name: string
  character: string
  order: number
  profile_path: string | null
  known_for_department?: string
}

interface TMDBCrewMember {
  id: number
  name: string
  job: string
  profile_path: string | null
  known_for_department?: string
}

interface TMDBCreditsResponse {
  cast: TMDBCastMember[]
  crew: TMDBCrewMember[]
}

async function fetchCredits(tmdbId: number): Promise<TMDBCreditsResponse> {
  const res = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/credits`, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
  })
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${res.statusText}`)
  return res.json() as Promise<TMDBCreditsResponse>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log('Fetching all films from database...')
  const films = await prisma.film.findMany({
    select: { id: true, title: true, tmdbId: true },
    orderBy: { title: 'asc' },
  })
  console.log(`Found ${films.length} films to process.\n`)

  let totalPersonsCreated = 0
  let totalLinksCreated = 0
  const failedFilms: string[] = []

  const BATCH_SIZE = 35
  for (let batchStart = 0; batchStart < films.length; batchStart += BATCH_SIZE) {
    const batch = films.slice(batchStart, batchStart + BATCH_SIZE)

    // Process batch in parallel
    const results = await Promise.allSettled(
      batch.map(async (film, idx) => {
        const filmIndex = batchStart + idx + 1
        console.log(`[${filmIndex}/${films.length}] Processing: ${film.title} (tmdbId: ${film.tmdbId})`)

        const credits = await fetchCredits(film.tmdbId)

        // Collect all persons to upsert
        type PersonEntry = {
          tmdbPersonId: number
          name: string
          profilePath: string | null
          knownForDepartment: string | null
          role: string
          character: string | null
          order: number | null
        }

        const entries: PersonEntry[] = []

        // Cast (all entries)
        for (const member of credits.cast) {
          entries.push({
            tmdbPersonId: member.id,
            name: member.name,
            profilePath: member.profile_path,
            knownForDepartment: member.known_for_department ?? null,
            role: 'ACTOR',
            character: member.character || null,
            order: member.order,
          })
        }

        // Crew (filtered roles)
        for (const member of credits.crew) {
          const role = CREW_JOB_MAP[member.job]
          if (!role) continue
          entries.push({
            tmdbPersonId: member.id,
            name: member.name,
            profilePath: member.profile_path,
            knownForDepartment: member.known_for_department ?? null,
            role,
            character: null,
            order: null,
          })
        }

        // Deduplicate: same person + same role for this film
        const seen = new Set<string>()
        const uniqueEntries = entries.filter((e) => {
          const key = `${e.tmdbPersonId}-${e.role}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })

        let personsCreated = 0
        let linksCreated = 0

        for (const entry of uniqueEntries) {
          // Upsert Person
          const slug = generatePersonSlug(entry.name, entry.tmdbPersonId)
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
            personsCreated++
          } catch (err: any) {
            // Slug collision — try with a suffix
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
              personsCreated++
            } else {
              throw err
            }
          }

          // Get the person id
          const person = await prisma.person.findUnique({
            where: { tmdbPersonId: entry.tmdbPersonId },
            select: { id: true },
          })
          if (!person) continue

          // Create FilmPerson link (skip if exists)
          try {
            await prisma.filmPerson.create({
              data: {
                filmId: film.id,
                personId: person.id,
                role: entry.role as any,
                character: entry.character,
                order: entry.order,
              },
            })
            linksCreated++
          } catch (err: any) {
            // Unique constraint violation — already exists, skip
            if (err.code === 'P2002') continue
            throw err
          }
        }

        return { personsCreated, linksCreated }
      })
    )

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        totalPersonsCreated += result.value.personsCreated
        totalLinksCreated += result.value.linksCreated
      } else {
        const film = batch[i]
        console.error(`  ✗ Failed: ${film.title} — ${result.reason}`)
        failedFilms.push(`${film.title} (tmdbId: ${film.tmdbId})`)
      }
    }

    // Rate limit: wait between batches
    if (batchStart + BATCH_SIZE < films.length) {
      console.log(`  → Batch done. Waiting 10s for rate limit...\n`)
      await sleep(10_000)
    }
  }

  console.log('\n═══════════════════════════════════════════')
  console.log('              BACKFILL COMPLETE')
  console.log('═══════════════════════════════════════════')
  console.log(`Films processed:     ${films.length}`)
  console.log(`Person upserts:      ${totalPersonsCreated}`)
  console.log(`FilmPerson links:    ${totalLinksCreated}`)
  console.log(`Failed films:        ${failedFilms.length}`)
  if (failedFilms.length > 0) {
    console.log('\nFailed films:')
    failedFilms.forEach((f) => console.log(`  - ${f}`))
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
