import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log('         PERSON DATA VERIFICATION')
  console.log('═══════════════════════════════════════════\n')

  let allPassed = true

  // 1. Every film has FilmPerson records
  console.log('1. Checking every film has FilmPerson records...')
  const films = await prisma.film.findMany({
    select: { id: true, title: true, _count: { select: { filmPersons: true } } },
  })
  const filmsWithNoLinks = films.filter((f) => f._count.filmPersons === 0)
  if (filmsWithNoLinks.length === 0) {
    console.log(`   ✓ PASS — All ${films.length} films have at least 1 FilmPerson link`)
  } else {
    console.log(`   ✗ FAIL — ${filmsWithNoLinks.length} films have 0 FilmPerson links:`)
    filmsWithNoLinks.slice(0, 20).forEach((f) => console.log(`     - ${f.title}`))
    if (filmsWithNoLinks.length > 20) console.log(`     ... and ${filmsWithNoLinks.length - 20} more`)
    allPassed = false
  }

  // 2. Director consistency
  console.log('\n2. Checking director consistency (old field vs FilmPerson DIRECTOR)...')
  const filmsWithDirector = await prisma.film.findMany({
    where: { director: { not: null } },
    select: {
      id: true,
      title: true,
      director: true,
      filmPersons: {
        where: { role: 'DIRECTOR' },
        select: { person: { select: { name: true } } },
      },
    },
  })
  let directorMatches = 0
  let directorMismatches = 0
  const mismatchList: string[] = []
  for (const film of filmsWithDirector) {
    const oldDirector = film.director!.trim().toLowerCase()
    const fpDirectors = film.filmPersons.map((fp) => fp.person.name.trim().toLowerCase())
    if (fpDirectors.includes(oldDirector)) {
      directorMatches++
    } else {
      directorMismatches++
      mismatchList.push(`${film.title}: old="${film.director}" vs FP=[${film.filmPersons.map((fp) => fp.person.name).join(', ')}]`)
    }
  }
  if (directorMismatches === 0) {
    console.log(`   ✓ PASS — All ${directorMatches} films with director field match FilmPerson DIRECTOR`)
  } else {
    console.log(`   ⚠ WARN — ${directorMatches} match, ${directorMismatches} mismatch:`)
    mismatchList.slice(0, 10).forEach((m) => console.log(`     - ${m}`))
    if (mismatchList.length > 10) console.log(`     ... and ${mismatchList.length - 10} more`)
  }

  // 3. No duplicate Person records
  console.log('\n3. Checking for duplicate Person records (by tmdbPersonId)...')
  const personCount = await prisma.person.count()
  const distinctTmdbIds = await prisma.person.groupBy({
    by: ['tmdbPersonId'],
  })
  if (distinctTmdbIds.length === personCount) {
    console.log(`   ✓ PASS — ${personCount} persons, all unique tmdbPersonId`)
  } else {
    console.log(`   ✗ FAIL — ${personCount} persons but only ${distinctTmdbIds.length} unique tmdbPersonIds`)
    allPassed = false
  }

  // 4. Person count sanity
  console.log('\n4. Counts and averages...')
  const totalLinks = await prisma.filmPerson.count()
  const actorLinks = await prisma.filmPerson.count({ where: { role: 'ACTOR' } })
  const directorLinks = await prisma.filmPerson.count({ where: { role: 'DIRECTOR' } })
  const crewLinks = totalLinks - actorLinks - directorLinks
  const filmsWithDirectors = await prisma.film.count({
    where: { filmPersons: { some: { role: 'DIRECTOR' } } },
  })
  const filmsWithCrew = await prisma.film.count({
    where: { filmPersons: { some: { role: { notIn: ['ACTOR', 'DIRECTOR'] } } } },
  })

  console.log(`   Total unique persons:    ${personCount}`)
  console.log(`   Total FilmPerson links:  ${totalLinks}`)
  console.log(`     - Actor links:         ${actorLinks}`)
  console.log(`     - Director links:      ${directorLinks}`)
  console.log(`     - Other crew links:    ${crewLinks}`)
  console.log(`   Avg cast per film:       ${films.length > 0 ? (actorLinks / films.length).toFixed(1) : 'N/A'}`)
  console.log(`   Films with directors:    ${filmsWithDirectors}/${films.length}`)
  console.log(`   Films with crew:         ${filmsWithCrew}/${films.length}`)

  // 5. Slug uniqueness
  console.log('\n5. Checking slug uniqueness...')
  const slugs = await prisma.person.findMany({ select: { slug: true } })
  const slugSet = new Set(slugs.map((s) => s.slug))
  if (slugSet.size === slugs.length) {
    console.log(`   ✓ PASS — All ${slugs.length} slugs are unique`)
  } else {
    console.log(`   ✗ FAIL — ${slugs.length} slugs but only ${slugSet.size} unique`)
    allPassed = false
  }

  // Summary
  console.log('\n═══════════════════════════════════════════')
  if (allPassed) {
    console.log('         ALL CHECKS PASSED ✓')
  } else {
    console.log('         SOME CHECKS FAILED ✗')
  }
  console.log('═══════════════════════════════════════════')

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
