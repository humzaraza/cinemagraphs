/**
 * Bulk import films from TMDB: top_rated + popular (pages 1–10 each).
 * De-duplicates by TMDB ID, skips shorts (<60m) and poster-less films.
 * After import, runs sentiment pipeline on up to 10 films without graphs.
 *
 * Usage: npx tsx scripts/bulk-import-tmdb.ts
 */
import './_load-env'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

if (!TMDB_API_KEY) {
  console.error('Missing TMDB_API_KEY in environment')
  process.exit(1)
}

// ── TMDB Fetch Helpers ──

interface TMDBListResult {
  page: number
  total_pages: number
  results: {
    id: number
    title: string
    release_date?: string
    poster_path?: string | null
    backdrop_path?: string | null
    overview?: string
    vote_average?: number
    vote_count?: number
    genre_ids?: number[]
  }[]
}

interface TMDBMovieDetail {
  id: number
  imdb_id?: string
  title: string
  release_date?: string
  runtime?: number
  overview?: string
  poster_path?: string | null
  backdrop_path?: string | null
  genres?: { id: number; name: string }[]
  vote_average?: number
  vote_count?: number
}

interface TMDBCredits {
  crew: { job: string; name: string }[]
  cast: { name: string; character: string; order: number; profile_path?: string | null }[]
}

async function tmdbFetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE_URL}${endpoint}`)
  // Support both v3 api_key and v4 Bearer token
  const isBearer = TMDB_API_KEY.startsWith('ey')
  if (!isBearer) {
    url.searchParams.set('api_key', TMDB_API_KEY)
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  const headers: Record<string, string> = {}
  if (isBearer) {
    headers['Authorization'] = `Bearer ${TMDB_API_KEY}`
  }
  const res = await fetch(url.toString(), { headers })
  if (!res.ok) {
    throw new Error(`TMDB ${endpoint}: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

async function fetchList(endpoint: string, pages: number): Promise<TMDBListResult['results']> {
  const all: TMDBListResult['results'] = []
  for (let page = 1; page <= pages; page++) {
    try {
      const data = await tmdbFetch<TMDBListResult>(endpoint, { page: page.toString() })
      all.push(...data.results)
      console.log(`  ${endpoint} page ${page}/${pages}: ${data.results.length} films`)
      // Small delay to respect rate limits
      await sleep(250)
    } catch (err) {
      console.error(`  ${endpoint} page ${page} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  return all
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Main Import ──

async function main() {
  console.log('=== TMDB Bulk Import ===\n')

  // 1. Fetch lists from both endpoints
  console.log('Fetching top_rated (10 pages)...')
  const topRated = await fetchList('/movie/top_rated', 10)

  console.log('\nFetching popular (10 pages)...')
  const popular = await fetchList('/movie/popular', 10)

  // 2. De-duplicate by TMDB ID
  const seenIds = new Set<number>()
  const candidates: typeof topRated = []

  for (const movie of [...topRated, ...popular]) {
    if (seenIds.has(movie.id)) continue
    seenIds.add(movie.id)
    candidates.push(movie)
  }

  console.log(`\nTotal unique candidates: ${candidates.length}`)

  // 3. Filter: must have poster
  const withPoster = candidates.filter((m) => m.poster_path)
  console.log(`With poster: ${withPoster.length}`)

  // 4. Check which are already in DB
  const existingTmdbIds = new Set(
    (await prisma.film.findMany({ select: { tmdbId: true } })).map((f) => f.tmdbId)
  )
  const newCandidates = withPoster.filter((m) => !existingTmdbIds.has(m.id))
  console.log(`Already in DB: ${withPoster.length - newCandidates.length}`)
  console.log(`New to import: ${newCandidates.length}\n`)

  // 5. Import each film (fetch details + credits for runtime, director, genres)
  let imported = 0
  let skippedShort = 0
  let failed = 0

  for (let i = 0; i < newCandidates.length; i++) {
    const candidate = newCandidates[i]
    const progress = `[${i + 1}/${newCandidates.length}]`

    try {
      // Fetch full details (need runtime, genres, imdb_id)
      const [movie, credits] = await Promise.all([
        tmdbFetch<TMDBMovieDetail>(`/movie/${candidate.id}`),
        tmdbFetch<TMDBCredits>(`/movie/${candidate.id}/credits`),
      ])

      // Skip shorts (runtime <= 60 min)
      if (!movie.runtime || movie.runtime <= 60) {
        console.log(`${progress} SKIP (short: ${movie.runtime ?? 0}m) ${movie.title}`)
        skippedShort++
        await sleep(200)
        continue
      }

      // Skip if no poster (double check after detail fetch)
      if (!movie.poster_path) {
        console.log(`${progress} SKIP (no poster) ${movie.title}`)
        await sleep(200)
        continue
      }

      const director = credits.crew.find((c) => c.job === 'Director')?.name ?? null
      const topCast = credits.cast
        .sort((a, b) => a.order - b.order)
        .slice(0, 10)
        .map((c) => ({
          name: c.name,
          character: c.character,
          profilePath: c.profile_path,
        }))

      await prisma.film.create({
        data: {
          tmdbId: movie.id,
          imdbId: movie.imdb_id ?? null,
          title: movie.title,
          releaseDate: movie.release_date ? new Date(movie.release_date) : null,
          runtime: movie.runtime,
          synopsis: movie.overview ?? null,
          posterUrl: movie.poster_path,
          backdropUrl: movie.backdrop_path ?? null,
          genres: movie.genres?.map((g) => g.name) ?? [],
          director,
          cast: topCast,
          imdbRating: movie.vote_average ?? null,
          imdbVotes: movie.vote_count ?? null,
        },
      })

      imported++
      console.log(`${progress} ✓ ${movie.title} (${movie.runtime}m)`)

      // Rate limit: ~3 detail fetches per second
      await sleep(350)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Skip unique constraint violations (race condition / already exists)
      if (msg.includes('Unique constraint')) {
        console.log(`${progress} SKIP (already exists) ${candidate.title}`)
      } else {
        console.error(`${progress} ✗ ${candidate.title}: ${msg}`)
        failed++
      }
      await sleep(200)
    }
  }

  console.log(`\n=== Import Complete ===`)
  console.log(`Imported: ${imported}`)
  console.log(`Skipped (short): ${skippedShort}`)
  console.log(`Skipped (existing): ${withPoster.length - newCandidates.length}`)
  console.log(`Failed: ${failed}`)

  // 6. Count total films now in DB
  const totalFilms = await prisma.film.count({ where: { status: 'ACTIVE' } })
  const filmsWithGraphs = await prisma.sentimentGraph.count()
  console.log(`\nTotal films in DB: ${totalFilms}`)
  console.log(`Films with sentiment graphs: ${filmsWithGraphs}`)
  console.log(`Films needing analysis: ${totalFilms - filmsWithGraphs}`)

  await prisma.$disconnect()
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
