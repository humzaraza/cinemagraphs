import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q')

  if (!query || query.trim().length === 0) {
    return Response.json({ error: 'Search query is required' }, { status: 400 })
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
}
