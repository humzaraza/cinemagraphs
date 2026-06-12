/**
 * Full SimilarFilm rebuild. NOT transactional: deleteMany runs up front, so
 * the table is empty/partial for the whole run (minutes at ~5k films) and
 * requests during that window can cache empty lists for up to TTL.FILM (1h).
 * After every run, flush the film:{id}:similar and film:{id}:detail:similar
 * Redis keys.
 */
import './_load-env'
import './_neon-ws'
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import {
  computeTopSimilarFor,
  DEFAULT_TOP_N,
  type FilmForScoring,
} from '../src/lib/similar-films'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

const INSERT_BATCH = 1_000

async function main() {
  console.log('Loading film catalog with scoring fields...')
  const films = await prisma.film.findMany({
    select: {
      id: true,
      title: true,
      keywords: true,
      genres: true,
      director: true,
      releaseDate: true,
      originalLanguage: true,
    },
    orderBy: { title: 'asc' },
  })
  console.log(`Catalog size: ${films.length}\n`)

  const scoringCatalog: FilmForScoring[] = films.map((f) => ({
    id: f.id,
    keywords: f.keywords,
    genres: f.genres,
    director: f.director,
    releaseDate: f.releaseDate,
    originalLanguage: f.originalLanguage,
  }))

  console.log('Clearing all existing SimilarFilm rows...')
  await prisma.similarFilm.deleteMany({})

  let totalRows = 0
  let zeroResultFilms = 0
  let buffer: Array<{
    filmId: string
    similarFilmId: string
    similarityScore: number
    matchSignals: object
  }> = []

  const startedAt = Date.now()
  for (let i = 0; i < scoringCatalog.length; i++) {
    const source = scoringCatalog[i]
    const top = computeTopSimilarFor(source, scoringCatalog, DEFAULT_TOP_N)

    if (top.length === 0) {
      zeroResultFilms++
    } else {
      for (const t of top) {
        buffer.push({
          filmId: source.id,
          similarFilmId: t.filmId,
          similarityScore: t.score,
          matchSignals: {
            ...t.signals,
            keywordsDegraded: t.keywordsDegraded,
            languageAffinity: t.languageAffinity,
          },
        })
      }
    }

    if (buffer.length >= INSERT_BATCH) {
      await prisma.similarFilm.createMany({ data: buffer })
      totalRows += buffer.length
      buffer = []
    }

    if ((i + 1) % 100 === 0 || i === scoringCatalog.length - 1) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(`[${i + 1}/${scoringCatalog.length}] processed (${elapsed}s, ${totalRows} rows written)`)
    }
  }

  if (buffer.length > 0) {
    await prisma.similarFilm.createMany({ data: buffer })
    totalRows += buffer.length
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log('\n═══════════════════════════════════════════')
  console.log('       SIMILAR FILMS BACKFILL COMPLETE')
  console.log('═══════════════════════════════════════════')
  console.log(`Films processed:       ${scoringCatalog.length}`)
  console.log(`Films with 0 matches:  ${zeroResultFilms}`)
  console.log(`Total rows written:    ${totalRows}`)
  console.log(`Elapsed:               ${elapsed}s`)

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
