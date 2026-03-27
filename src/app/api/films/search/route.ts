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

    const films = await prisma.film.findMany({
      where: {
        status: 'ACTIVE',
        title: {
          contains: sanitizedQuery,
          mode: 'insensitive',
        },
      },
      include: { sentimentGraph: { select: { overallScore: true } } },
      take: 20,
      orderBy: { title: 'asc' },
    })

    return Response.json({ films, query: sanitizedQuery })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to search films')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
