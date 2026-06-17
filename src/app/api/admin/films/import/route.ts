import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { getMovieDetails, importMovie, searchMovies } from '@/lib/tmdb'
import { apiLogger } from '@/lib/logger'

export async function POST(request: Request) {
  try {
    const session = await getMobileOrServerSession()

    if (!session?.user || session.user.role !== 'ADMIN') {
      return Response.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 403 })
    }

    const body = await request.json()
    const { tmdbId, query, resolveId } = body as {
      tmdbId?: number
      query?: string
      resolveId?: number
    }

    // Search mode: return TMDB search results
    if (query && typeof query === 'string') {
      const sanitizedQuery = query.trim().slice(0, 200)
      if (sanitizedQuery.length === 0) {
        return Response.json({ error: 'Search query is required', code: 'BAD_REQUEST' }, { status: 400 })
      }
      const results = await searchMovies(sanitizedQuery)
      return Response.json({ results: results.results })
    }

    // Resolve mode: look up a single film by TMDB ID WITHOUT importing it, so the
    // admin can preview it as a result card and import it with a deliberate click.
    // Returned in the same { results } shape as search so the UI renders it identically.
    if (resolveId && typeof resolveId === 'number' && Number.isInteger(resolveId) && resolveId > 0) {
      try {
        const movie = await getMovieDetails(resolveId)
        return Response.json({ results: [movie] })
      } catch {
        return Response.json(
          { error: 'No TMDB film found with that ID', code: 'NOT_FOUND' },
          { status: 404 }
        )
      }
    }

    // Import mode: import a specific film by TMDB ID
    if (tmdbId && typeof tmdbId === 'number' && Number.isInteger(tmdbId) && tmdbId > 0) {
      const film = await importMovie(tmdbId)
      return Response.json({ film })
    }

    return Response.json(
      { error: 'Provide a query (string), resolveId (number), or tmdbId (number)', code: 'BAD_REQUEST' },
      { status: 400 }
    )
  } catch (err) {
    apiLogger.error({ err }, 'Failed to import film')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
