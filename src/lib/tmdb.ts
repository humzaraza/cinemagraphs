import { prisma } from './prisma'
import { cachedQuery, KEYS, TTL } from './cache'

// Re-export the pure URL helper so callers can keep `import { getBackdropUrl } from '@/lib/tmdb'`
// while client components avoid pulling in the prisma-touching surface
// of this file by importing from '@/lib/tmdb-url' directly.
export { getBackdropUrl } from './tmdb-url'

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

interface TMDBMovie {
  id: number
  imdb_id?: string
  title: string
  release_date?: string
  runtime?: number
  overview?: string
  poster_path?: string
  backdrop_path?: string
  genres?: { id: number; name: string }[]
  vote_average?: number
  vote_count?: number
  popularity?: number
}

interface TMDBCredits {
  crew: { job: string; name: string }[]
  cast: { name: string; character: string; order: number; profile_path?: string }[]
}

interface TMDBReview {
  author: string
  content: string
  url: string
  author_details?: { rating?: number }
}

interface TMDBSearchResult {
  page: number
  total_pages: number
  total_results: number
  results: TMDBMovie[]
}

async function tmdbFetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE_URL}${endpoint}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
  })
  if (!res.ok) {
    throw new Error(`TMDB API error: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export async function searchMovies(query: string, page: number = 1) {
  return tmdbFetch<TMDBSearchResult>('/search/movie', {
    query,
    page: page.toString(),
  })
}

export async function getMovieDetails(tmdbId: number) {
  return tmdbFetch<TMDBMovie>(`/movie/${tmdbId}`)
}

export async function getMovieCredits(tmdbId: number) {
  return tmdbFetch<TMDBCredits>(`/movie/${tmdbId}/credits`)
}

export async function getMovieReviews(tmdbId: number, page: number = 1) {
  return tmdbFetch<{ results: TMDBReview[] }>(`/movie/${tmdbId}/reviews`, {
    page: page.toString(),
  })
}

interface TMDBImage {
  file_path: string
  iso_639_1: string | null
  vote_count: number
  vote_average: number
  width: number
  height: number
}

export interface TMDBImagesResponse {
  backdrops: TMDBImage[]
  logos: TMDBImage[]
  posters: TMDBImage[]
}

export async function getMovieImages(
  tmdbId: number,
  options?: { includeImageLanguage?: string }
): Promise<TMDBImagesResponse> {
  const lang = options?.includeImageLanguage
  const key = lang ? KEYS.tmdbImages(tmdbId, lang) : KEYS.tmdbImages(tmdbId)
  return cachedQuery(key, TTL.TMDB_IMAGES, async () => {
    const params: Record<string, string> = {}
    if (lang) {
      params.include_image_language = lang
    }
    return tmdbFetch<TMDBImagesResponse>(`/movie/${tmdbId}/images`, params)
  })
}

export async function getMovieBackdropUrls(tmdbId: number, size: string = 'w1280'): Promise<string[]> {
  try {
    const data = await getMovieImages(tmdbId)
    return [...data.backdrops]
      .sort((a, b) => b.vote_count - a.vote_count || b.vote_average - a.vote_average)
      .map((img) => `https://image.tmdb.org/t/p/${size}${img.file_path}`)
  } catch {
    return []
  }
}

interface TMDBVideo {
  key: string
  site: string
  type: string
  name: string
}

export async function getMovieTrailerKey(tmdbId: number): Promise<string | null> {
  try {
    const data = await tmdbFetch<{ results: TMDBVideo[] }>(`/movie/${tmdbId}/videos`)
    const trailer = data.results.find((v) => v.site === 'YouTube' && v.type === 'Trailer')
    return trailer?.key ?? null
  } catch {
    return null
  }
}

interface TMDBPerson {
  id: number
  biography: string
  birthday: string | null
  deathday: string | null
  place_of_birth: string | null
  known_for_department: string | null
}

export async function getPersonDetails(tmdbPersonId: number): Promise<TMDBPerson> {
  return tmdbFetch<TMDBPerson>(`/person/${tmdbPersonId}`)
}

export async function getNowPlayingMovies(region: string = 'CA'): Promise<TMDBMovie[]> {
  return cachedQuery(KEYS.tmdbNowPlaying(region), TTL.TMDB_NOW_PLAYING, async () => {
    const data = await tmdbFetch<{ results: TMDBMovie[] }>('/movie/now_playing', { region })
    return data.results
  })
}

interface TMDBKeyword {
  id: number
  name: string
}

interface TMDBKeywordsResponse {
  id: number
  keywords: TMDBKeyword[]
}

export async function getMovieKeywords(tmdbId: number): Promise<string[]> {
  const data = await tmdbFetch<TMDBKeywordsResponse>(`/movie/${tmdbId}/keywords`)
  return data.keywords.map((k) => k.name.toLowerCase())
}

export async function importMovie(tmdbId: number) {
  const existing = await prisma.film.findUnique({ where: { tmdbId } })
  if (existing) return existing

  const [movie, credits, keywords] = await Promise.all([
    getMovieDetails(tmdbId),
    getMovieCredits(tmdbId),
    getMovieKeywords(tmdbId).catch(() => [] as string[]),
  ])

  const director = credits.crew.find((c) => c.job === 'Director')?.name ?? null
  const topCast = credits.cast
    .sort((a, b) => a.order - b.order)
    .slice(0, 10)
    .map((c) => ({
      name: c.name,
      character: c.character,
      profilePath: c.profile_path,
    }))

  const film = await prisma.film.create({
    data: {
      tmdbId: movie.id,
      imdbId: movie.imdb_id ?? null,
      title: movie.title,
      releaseDate: movie.release_date ? new Date(movie.release_date) : null,
      runtime: movie.runtime ?? null,
      synopsis: movie.overview ?? null,
      posterUrl: movie.poster_path ?? null,
      backdropUrl: movie.backdrop_path ?? null,
      genres: movie.genres?.map((g) => g.name) ?? [],
      director,
      cast: topCast,
      imdbRating: movie.vote_average ?? null,
      imdbVotes: movie.vote_count ?? null,
      keywords,
    },
  })

  // Sync Person/FilmPerson records from credits
  try {
    const { syncFilmCredits } = await import('./person-sync')
    await syncFilmCredits(film.id, tmdbId)
  } catch {
    // Credits sync failed. Film still created successfully.
  }

  // Compute top-20 similar films for the new entry, then recompute each of
  // those 20 neighbors so the new film can also appear in their precomputed
  // lists. Bidirectional, one level deep. Periodic full rebuilds
  // (scripts/backfill-similar-films.ts) remain useful for the long tail of
  // films that are not in any new film's top-20 but might still benefit from
  // including new films in their own top-20.
  try {
    const { recomputeSimilarFilmsForFilm } = await import('./similar-films')
    await recomputeSimilarFilmsForFilm(film.id)
  } catch {
    // Similarity compute failed. Film still created successfully.
  }

  return film
}
