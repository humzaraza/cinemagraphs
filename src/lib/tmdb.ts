import { prisma } from './prisma'
import { cachedQuery, KEYS, TTL } from './cache'

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

export async function getNowPlayingMovies(region: string = 'CA'): Promise<TMDBMovie[]> {
  return cachedQuery(KEYS.tmdbNowPlaying(region), TTL.TMDB_NOW_PLAYING, async () => {
    const data = await tmdbFetch<{ results: TMDBMovie[] }>('/movie/now_playing', { region })
    return data.results
  })
}

export async function importMovie(tmdbId: number) {
  const existing = await prisma.film.findUnique({ where: { tmdbId } })
  if (existing) return existing

  const [movie, credits] = await Promise.all([
    getMovieDetails(tmdbId),
    getMovieCredits(tmdbId),
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
    },
  })

  return film
}
