import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { withDerivedFields } from '@/lib/films'
import { cachedQuery, TTL } from '@/lib/cache'
import { computeSwingMagnitude } from '@/lib/sentiment-metrics'
import { ARC_SHAPES } from '@/lib/arc-classifier'

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
    const hasBackdrop = searchParams.get('hasBackdrop') === 'true'
    // arcShape tag filter (e.g. "hidden peak"). Validated against the known
    // tags; an unknown value is ignored rather than silently returning all.
    const arcShapeParam = searchParams.get('arcShape')?.trim() || ''
    const arcShapeTag = (ARC_SHAPES as readonly string[]).includes(arcShapeParam)
      ? arcShapeParam
      : ''

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
    if (hasBackdrop) {
      where.backdropUrl = { not: null }
    }

    // sentimentGraph relation filter. An arcShape tag filter matches on the
    // related record's fields (which implies the graph exists), so it subsumes
    // the "must have a graph" requirement of the highest/swing sorts;
    // otherwise those sorts just require a non-null graph.
    if (arcShapeTag) {
      where.sentimentGraph = { arcShape: { has: arcShapeTag } }
    } else if (sort === 'highest' || sort === 'swing') {
      where.sentimentGraph = { isNot: null }
    }

    // Build orderBy
    let orderBy: Record<string, unknown> | Record<string, unknown>[]
    switch (sort) {
      case 'za':
        orderBy = { title: 'desc' }
        break
      case 'highest':
        // Relation filter (must have a graph) is set in the where block above.
        orderBy = { sentimentGraph: { overallScore: 'desc' } }
        break
      // 'swing' intentionally has no DB orderBy. biggestSwing is a
      // natural-language sentence, so ordering by it sorted alphabetically (the
      // bug this replaces). Real swing magnitude is computed at query time in
      // the dedicated branch below.
      case 'recent':
        orderBy = { createdAt: 'desc' }
        break
      case 'popular':
        // imdbVotes proxies popularity for the banner-backdrop picker.
        // Prisma orders nulls last by default on Postgres for desc.
        orderBy = [{ imdbVotes: { sort: 'desc', nulls: 'last' } }, { title: 'asc' }]
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

    // sort=swing: rank by computed swing magnitude (abs(peak - low) from the
    // precomputed peakMoment/lowestMoment). Prisma cannot ORDER BY a
    // JSON-derived expression, so rank in memory; at a few thousand graphed
    // films this is cheap and mirrors the q-path's in-JS sort. Cached like the
    // rest of the browse list.
    if (sort === 'swing') {
      // Relation filter (graph required, plus any arcShape tag) is set above.
      const swingKey =
        `films-list:swing:${encodeURIComponent(genre)}:${encodeURIComponent(arcShapeTag)}` +
        `:${page}:${limit}:${nowPlaying}:${ticker}:${hasBackdrop}`
      const payload = await cachedQuery(swingKey, TTL.FILMS_LIST, async () => {
        const all = await prisma.film.findMany({
          where,
          include: {
            sentimentGraph: {
              select: {
                overallScore: true,
                dataPoints: true,
                biggestSwing: true,
                peakMoment: true,
                lowestMoment: true,
              },
            },
          },
        })
        const ranked = all
          .map((f) => ({
            f,
            swing: computeSwingMagnitude(
              f.sentimentGraph?.peakMoment,
              f.sentimentGraph?.lowestMoment,
            ),
          }))
          // Descending swing, then film.id ascending as a stable tiebreaker so
          // pagination is deterministic across requests.
          .sort((a, b) => b.swing - a.swing || a.f.id.localeCompare(b.f.id))
        const total = ranked.length
        const films = ranked.slice(skip, skip + limit).map((x) => withDerivedFields(x.f))
        return {
          films,
          pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        }
      })
      return Response.json(payload)
    }

    // Cache the browse list (no q). The key covers every param that changes
    // the result; the 120s TTL keeps newly added films visible within 2
    // minutes without needing list-cache invalidation wired into writes.
    const cacheKey =
      `films-list:${encodeURIComponent(sort)}:${encodeURIComponent(genre)}` +
      `:${encodeURIComponent(arcShapeTag)}:${page}:${limit}:${nowPlaying}:${ticker}:${hasBackdrop}`

    const payload = await cachedQuery(cacheKey, TTL.FILMS_LIST, async () => {
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

      return {
        films: films.map(withDerivedFields),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      }
    })

    return Response.json(payload)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch films')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
