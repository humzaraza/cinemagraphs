import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { generateAndStoreWikiBeats, type GenerateWikiBeatsResult } from '@/lib/wiki-beat-fallback'
import { invalidateFilmCache } from '@/lib/cache'
import { apiLogger } from '@/lib/logger'

export const maxDuration = 300 // 5 minutes for Vercel

const CONCURRENCY = 5

interface BatchResult {
  filmId: string
  title?: string
  status: GenerateWikiBeatsResult['status']
  beatCount?: number
}

/**
 * Batch-generate Wikipedia beats for films that don't have any beats yet.
 *
 * Accepts optional `{ filmIds: string[] }` in the body to target specific films,
 * or nothing to target all active films missing beats & sentiment graphs.
 *
 * Skips films that already have a SentimentGraph (NLP beats take priority) or
 * existing FilmBeats (no overwrites). Processes films in parallel chunks of
 * CONCURRENCY to stay well under Vercel's 5-minute limit.
 */
export async function POST(request: Request) {
  const session = await getMobileOrServerSession()
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const providedIds: unknown = body?.filmIds
  const force = body?.force === true
  const limit = typeof body?.limit === 'number' && body.limit > 0 && body.limit <= 100 ? body.limit : 20

  let filmIds: string[]

  if (Array.isArray(providedIds) && providedIds.length > 0) {
    if (!providedIds.every((id) => typeof id === 'string')) {
      return Response.json(
        { error: 'All filmIds must be strings', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }
    if (providedIds.length > 100) {
      return Response.json(
        { error: 'Maximum 100 films per batch', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }
    filmIds = providedIds as string[]
  } else {
    // Auto-select: active films missing both sentiment graphs AND film beats
    const candidates = await prisma.film.findMany({
      where: {
        status: 'ACTIVE',
        sentimentGraph: { is: null },
        filmBeats: { is: null },
        releaseDate: { not: null },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    filmIds = candidates.map((f) => f.id)
  }

  // Fetch all titles upfront so we don't do an extra DB roundtrip per film
  const filmTitles = await prisma.film.findMany({
    where: { id: { in: filmIds } },
    select: { id: true, title: true },
  })
  const titleMap = new Map(filmTitles.map((f) => [f.id, f.title]))

  const results: BatchResult[] = []
  let generated = 0
  let skipped = 0
  let failed = 0

  async function processOne(filmId: string): Promise<{
    result: BatchResult
    outcome: 'generated' | 'skipped' | 'failed'
  }> {
    try {
      const result = await generateAndStoreWikiBeats(filmId, { force })
      if (result.status === 'generated') {
        await invalidateFilmCache(filmId)
      }
      return {
        result: {
          filmId,
          title: titleMap.get(filmId),
          status: result.status,
          beatCount: result.status === 'generated' ? result.beatCount : undefined,
        },
        outcome: result.status === 'generated' ? 'generated' : 'skipped',
      }
    } catch (err) {
      apiLogger.error({ err, filmId }, 'Wiki beat generation failed in batch')
      return {
        result: {
          filmId,
          title: titleMap.get(filmId),
          status: 'skipped_generation_failed',
        },
        outcome: 'failed',
      }
    }
  }

  // Process in chunks of CONCURRENCY (parallel within each chunk, sequential
  // between chunks). Keeps each chunk fast while bounding DB + API concurrency.
  for (let i = 0; i < filmIds.length; i += CONCURRENCY) {
    const chunk = filmIds.slice(i, i + CONCURRENCY)
    const chunkResults = await Promise.all(chunk.map(processOne))
    for (const { result, outcome } of chunkResults) {
      results.push(result)
      if (outcome === 'generated') generated++
      else if (outcome === 'skipped') skipped++
      else failed++
    }
  }

  apiLogger.info(
    { total: filmIds.length, generated, skipped, failed },
    'Batch wiki beat generation complete'
  )

  return Response.json({
    total: filmIds.length,
    generated,
    skipped,
    failed,
    results,
  })
}
