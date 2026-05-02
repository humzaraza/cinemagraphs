import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { withDerivedFields } from '@/lib/films'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '24')))
    const skip = (page - 1) * limit
    const sort = searchParams.get('sort') || 'az'
    const genre = searchParams.get('genre') || ''
    const q = searchParams.get('q')?.trim().slice(0, 200) || ''
    const nowPlaying = searchParams.get('nowPlaying') === 'true'
    const ticker = searchParams.get('ticker') === 'true'

    // Build where clause
    const where: Record<string, unknown> = { status: 'ACTIVE' }
    if (genre) {
      where.genres = { has: genre }
    }
    if (q) {
      where.title = { contains: q, mode: 'insensitive' }
    }
    if (nowPlaying) {
      where.nowPlaying = true
    }
    if (ticker) {
      where.tickerOverride = 'force_show'
    }

    // Build orderBy
    let orderBy: Record<string, unknown> | Record<string, unknown>[]
    switch (sort) {
      case 'za':
        orderBy = { title: 'desc' }
        break
      case 'highest':
        orderBy = { sentimentGraph: { overallScore: 'desc' } }
        where.sentimentGraph = { isNot: null }
        break
      case 'swing':
        orderBy = { sentimentGraph: { biggestSwing: 'desc' } }
        where.sentimentGraph = { isNot: null }
        break
      case 'recent':
        orderBy = { createdAt: 'desc' }
        break
      case 'az':
      default:
        orderBy = { title: 'asc' }
        break
    }

    // When searching by title, sort by match quality (exact > starts-with > contains)
    // then paginate in JS so the best match appears first across all pages
    if (q) {
      const allMatches = await prisma.film.findMany({
        where,
        include: {
          sentimentGraph: {
            select: { overallScore: true, dataPoints: true, biggestSwing: true },
          },
        },
        orderBy,
        take: 500,
      })

      const qLower = q.toLowerCase()
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

      const total = allMatches.length
      const films = allMatches.slice(skip, skip + limit)

      return Response.json({
        films: films.map(withDerivedFields),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      })
    }

    const [films, total] = await Promise.all([
      prisma.film.findMany({
        where,
        include: {
          sentimentGraph: {
            select: { overallScore: true, dataPoints: true, biggestSwing: true },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.film.count({ where }),
    ])

    return Response.json({
      films: films.map(withDerivedFields),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch films')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
