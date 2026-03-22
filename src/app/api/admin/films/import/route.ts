import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { importMovie, searchMovies } from '@/lib/tmdb'

export async function POST(request: Request) {
  const session = await getServerSession(authOptions)

  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const { tmdbId, query } = body as { tmdbId?: number; query?: string }

  // Search mode: return TMDB search results
  if (query && typeof query === 'string') {
    const sanitizedQuery = query.trim().slice(0, 200)
    if (sanitizedQuery.length === 0) {
      return Response.json({ error: 'Search query is required' }, { status: 400 })
    }
    const results = await searchMovies(sanitizedQuery)
    return Response.json({ results: results.results })
  }

  // Import mode: import a specific film by TMDB ID
  if (tmdbId && typeof tmdbId === 'number' && Number.isInteger(tmdbId) && tmdbId > 0) {
    const film = await importMovie(tmdbId)
    return Response.json({ film })
  }

  return Response.json(
    { error: 'Provide either a tmdbId (number) or query (string)' },
    { status: 400 }
  )
}
