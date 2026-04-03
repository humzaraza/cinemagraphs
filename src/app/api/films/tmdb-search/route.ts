import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { searchMovies } from '@/lib/tmdb'
import { apiLogger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams.get('q')

    if (!query || query.trim().length === 0) {
      return Response.json({ error: 'Search query is required' }, { status: 400 })
    }

    const sanitizedQuery = query.trim().slice(0, 200)
    const tmdbResults = await searchMovies(sanitizedQuery)

    // Check which tmdbIds already exist in our database
    const tmdbIds = tmdbResults.results.map((r) => r.id)
    const existingFilms = await prisma.film.findMany({
      where: { tmdbId: { in: tmdbIds } },
      select: { id: true, tmdbId: true },
    })
    const existingMap = new Map(existingFilms.map((f) => [f.tmdbId, f.id]))

    const results = tmdbResults.results.slice(0, 10).map((movie) => ({
      tmdbId: movie.id,
      title: movie.title,
      releaseDate: movie.release_date || null,
      posterPath: movie.poster_path || null,
      overview: movie.overview || null,
      alreadyExists: existingMap.has(movie.id),
      existingFilmId: existingMap.get(movie.id) || null,
    }))

    return Response.json({ results })
  } catch (err) {
    apiLogger.error({ err }, 'TMDB search failed')
    return Response.json({ error: 'Failed to search TMDB' }, { status: 500 })
  }
}
