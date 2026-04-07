import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

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
      films,
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
