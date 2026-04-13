import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams.get('q')

    if (!query || query.trim().length === 0) {
      return Response.json({ error: 'Search query is required', code: 'BAD_REQUEST' }, { status: 400 })
    }

    const sanitizedQuery = query.trim().slice(0, 200)

    const allMatches = await prisma.film.findMany({
      where: {
        status: 'ACTIVE',
        title: {
          contains: sanitizedQuery,
          mode: 'insensitive',
        },
      },
      include: { sentimentGraph: { select: { overallScore: true } } },
      orderBy: { title: 'asc' },
      take: 200,
    })

    // Sort by match quality: exact > starts-with > contains, then alphabetical
    const qLower = sanitizedQuery.toLowerCase()
    allMatches.sort((a, b) => {
      const aLower = a.title.toLowerCase()
      const bLower = b.title.toLowerCase()
      const aExact = aLower === qLower
      const bExact = bLower === qLower
      if (aExact !== bExact) return aExact ? -1 : 1
      const aStarts = aLower.startsWith(qLower)
      const bStarts = bLower.startsWith(qLower)
      if (aStarts !== bStarts) return aStarts ? -1 : 1
      return aLower.localeCompare(bLower)
    })

    const films = allMatches.slice(0, 20)

    return Response.json({ films, query: sanitizedQuery })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to search films')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
