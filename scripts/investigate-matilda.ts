/**
 * One-off: investigate why Matilda (1996) has so few reviews.
 *
 * - Locates the film, prints TMDB / IMDb IDs
 * - Lists existing Review rows
 * - Calls each fetcher individually (TMDB, IMDb, Critic, Guardian) and
 *   reports counts + any error
 *
 * Usage: npx tsx scripts/investigate-matilda.ts
 */
import 'dotenv/config'
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import { prisma } from '../src/lib/prisma'
import {
  fetchTMDBReviews,
  fetchIMDbReviews,
  fetchCriticReviews,
  fetchGuardianReviews,
} from '../src/lib/sources'

async function main() {
  console.log('=== INVESTIGATING MATILDA (1996) ===\n')

  // 1. Locate the film
  const candidates = await prisma.film.findMany({
    where: {
      title: { equals: 'Matilda', mode: 'insensitive' },
    },
    select: {
      id: true,
      title: true,
      tmdbId: true,
      imdbId: true,
      releaseDate: true,
      director: true,
      runtime: true,
    },
  })

  console.log(`Found ${candidates.length} film(s) titled "Matilda":`)
  for (const c of candidates) {
    console.log(
      `  - ${c.title} (${c.releaseDate?.getFullYear() ?? 'N/A'}) — id=${c.id} tmdbId=${c.tmdbId} imdbId=${c.imdbId ?? 'MISSING'} director=${c.director ?? 'N/A'} runtime=${c.runtime ?? 'N/A'}`
    )
  }
  console.log()

  // Pick the 1996 one
  const film = candidates.find((c) => c.releaseDate?.getFullYear() === 1996)
  if (!film) {
    console.error('No 1996 Matilda found in DB — aborting')
    await prisma.$disconnect()
    process.exit(1)
  }

  console.log('--- 1996 MATILDA IDS ---')
  console.log(`Film row id: ${film.id}`)
  console.log(`TMDB ID:     ${film.tmdbId}`)
  console.log(`IMDb ID:     ${film.imdbId ?? 'MISSING'}`)
  console.log()
  console.log('Reference IDs for the 1996 Danny DeVito film:')
  console.log('  TMDB: 1812  (https://www.themoviedb.org/movie/1812)')
  console.log('  IMDb: tt0117008  (https://www.imdb.com/title/tt0117008/)')
  console.log()

  // 2. Existing reviews in DB
  console.log('--- EXISTING REVIEWS IN DB ---')
  const existing = await prisma.review.findMany({
    where: { filmId: film.id },
    select: {
      id: true,
      sourcePlatform: true,
      sourceUrl: true,
      author: true,
      fetchedAt: true,
      reviewText: true,
    },
    orderBy: { fetchedAt: 'desc' },
  })
  console.log(`Total reviews in DB: ${existing.length}`)
  for (const r of existing) {
    const wordCount = r.reviewText.trim().split(/\s+/).length
    console.log(
      `  [${r.sourcePlatform}] author="${r.author ?? '—'}" fetchedAt=${r.fetchedAt.toISOString()} words=${wordCount}`
    )
    console.log(`    url: ${r.sourceUrl ?? '—'}`)
    console.log(`    preview: "${r.reviewText.slice(0, 120).replace(/\s+/g, ' ')}..."`)
  }
  console.log()

  // 3. Live fetcher tests — pull the full Film record so each fetcher has
  // everything it needs.
  const fullFilm = await prisma.film.findUnique({ where: { id: film.id } })
  if (!fullFilm) {
    console.error('Lost film row mid-script — aborting')
    await prisma.$disconnect()
    process.exit(1)
  }

  console.log('--- LIVE FETCHER TESTS ---\n')

  type FetcherTest = {
    name: string
    run: () => Promise<{ count: number; ok?: boolean; reason?: string; sample?: string; error?: string }>
  }

  const tests: FetcherTest[] = [
    {
      name: 'TMDB reviews API',
      async run() {
        try {
          const result = await fetchTMDBReviews(fullFilm)
          return {
            count: result.reviews.length,
            ok: result.ok,
            reason: result.reason,
            sample: result.reviews[0]?.reviewText.slice(0, 100),
          }
        } catch (err) {
          return { count: 0, error: err instanceof Error ? err.message : String(err) }
        }
      },
    },
    {
      name: 'IMDb (RapidAPI imdb232) — user + critic',
      async run() {
        try {
          const result = await fetchIMDbReviews(fullFilm)
          return {
            count: result.reviews.length,
            ok: result.ok,
            reason: result.reason,
            sample: result.reviews[0]?.reviewText.slice(0, 100),
          }
        } catch (err) {
          return { count: 0, error: err instanceof Error ? err.message : String(err) }
        }
      },
    },
    {
      name: 'Roger Ebert (critic blog)',
      async run() {
        try {
          const result = await fetchCriticReviews(fullFilm)
          return {
            count: result.reviews.length,
            ok: result.ok,
            reason: result.reason,
            sample: result.reviews[0]?.reviewText.slice(0, 100),
          }
        } catch (err) {
          return { count: 0, error: err instanceof Error ? err.message : String(err) }
        }
      },
    },
    {
      name: 'Guardian search',
      async run() {
        try {
          const result = await fetchGuardianReviews(fullFilm)
          return {
            count: result.reviews.length,
            ok: result.ok,
            reason: result.reason,
            sample: result.reviews[0]?.reviewText.slice(0, 100),
          }
        } catch (err) {
          return { count: 0, error: err instanceof Error ? err.message : String(err) }
        }
      },
    },
  ]

  for (const t of tests) {
    process.stdout.write(`Testing ${t.name}... `)
    const result = await t.run()
    if (result.error) {
      console.log(`ERROR`)
      console.log(`  Error: ${result.error}`)
    } else {
      const status = result.ok === false ? `✗ ${result.reason ?? 'unknown'}` : '✓'
      console.log(`returned ${result.count} review(s) [${status}]`)
      if (result.sample) console.log(`  Sample: "${result.sample}..."`)
    }
  }

  // 4. Also check raw Roger Ebert URL since slug rules differ
  console.log('\n--- ROGER EBERT URL PROBE ---')
  const ebertUrls = [
    'https://www.rogerebert.com/reviews/matilda-1996',
    'https://www.rogerebert.com/reviews/matilda',
  ]
  for (const url of ebertUrls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Cinemagraphs/1.0 (movie sentiment analysis)' },
        signal: AbortSignal.timeout(5000),
      })
      console.log(`  ${url} → ${res.status}`)
    } catch (err) {
      console.log(`  ${url} → ERROR: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 5. Confirm env vars that gate each fetcher
  console.log('\n--- ENV GATE CHECK ---')
  console.log(`TMDB_API_KEY:    ${process.env.TMDB_API_KEY ? 'set' : 'MISSING'}`)
  console.log(`RAPIDAPI_KEY:    ${process.env.RAPIDAPI_KEY ? 'set' : 'MISSING'}`)
  console.log(`RAPIDAPI_IMDB_HOST: ${process.env.RAPIDAPI_IMDB_HOST ?? '(default imdb232.p.rapidapi.com)'}`)
  console.log(`GUARDIAN_API_KEY: ${process.env.GUARDIAN_API_KEY ? 'set' : 'MISSING'}`)

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
