import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { generateHybridAndStore } from '@/lib/sentiment-pipeline'
import { invalidateFilmCache, invalidateHomepageCache } from '@/lib/cache'
import { apiLogger } from '@/lib/logger'

export const maxDuration = 300 // 5 minutes for Vercel

const TIME_BUDGET_MS = 280_000
const MIN_QUALITY_REVIEWS_FOR_GRAPH = 3

// Quality-review filter — mirrors the private isQualityReview in
// sentiment-pipeline.ts (and the copy in bulk-import/route.ts). Kept in
// sync by hand because the canonical version is not exported from the
// pipeline module. Three ~5-line copies is cheaper than coupling each
// caller to pipeline internals.
const ENGLISH_REGEX =
  /^[\x00-\x7F\u00C0-\u024F\u2018-\u201D\u2014\u2013\u2026\s.,;:!?'"()\-[\]{}@#$%^&*+=/<>~`|\\]+$/
const MIN_WORD_COUNT = 50

function isQualityReview(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (words.length < MIN_WORD_COUNT) return false
  if (!ENGLISH_REGEX.test(text.slice(0, 500))) return false
  return true
}

/**
 * Generate sentiment graphs for films that don't have one yet AND have
 * at least 3 quality reviews. Simple null check on `film.sentimentGraph`
 * — films that already have a graph are skipped entirely (no hash check,
 * no force flag). This is specifically the post-bulk-import cleanup pass
 * for the admin "Generate Missing Graphs" button.
 *
 * Streams progress via Server-Sent Events so the admin UI can show
 * "Generating graph for {title} ({n}/{total})" in real time. On timeout
 * the stream emits a `timeout` event with `stoppedAtTitle` and closes —
 * re-running the endpoint naturally resumes because the remaining films
 * still satisfy `sentimentGraph: { is: null }`, so they reappear in the
 * candidate list on the next query.
 */
export async function POST() {
  const session = await getMobileOrServerSession()
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json(
      { error: 'Unauthorized', code: 'FORBIDDEN' },
      { status: 403 }
    )
  }

  const startTime = Date.now()
  const deadline = startTime + TIME_BUDGET_MS

  // ── Step 1: coarse pass — all active films with no graph ──
  // Pull `_count.reviews` so we can drop films with <3 total reviews
  // before loading any reviewText. For 2000 films × 50 reviews each the
  // review-text load would be ~25MB; the coarse filter keeps memory
  // bounded to only the films that could plausibly qualify.
  const filmsNoGraph = await prisma.film.findMany({
    where: {
      status: 'ACTIVE',
      sentimentGraph: { is: null },
    },
    select: {
      id: true,
      title: true,
      _count: { select: { reviews: true } },
    },
    orderBy: { title: 'asc' },
  })

  const maybeEligible = filmsNoGraph.filter(
    (f) => f._count.reviews >= MIN_QUALITY_REVIEWS_FOR_GRAPH
  )

  // ── Step 2: quality-filter pass — load reviewText only for the
  //     maybe-eligible films, and count quality reviews per film.
  const reviewRows = maybeEligible.length
    ? await prisma.review.findMany({
        where: { filmId: { in: maybeEligible.map((f) => f.id) } },
        select: { filmId: true, reviewText: true },
      })
    : []

  const qualityByFilm = new Map<string, number>()
  for (const r of reviewRows) {
    if (isQualityReview(r.reviewText)) {
      qualityByFilm.set(r.filmId, (qualityByFilm.get(r.filmId) ?? 0) + 1)
    }
  }

  const candidates = maybeEligible
    .filter(
      (f) => (qualityByFilm.get(f.id) ?? 0) >= MIN_QUALITY_REVIEWS_FOR_GRAPH
    )
    .map((f) => ({
      id: f.id,
      title: f.title,
      qualityCount: qualityByFilm.get(f.id) ?? 0,
    }))

  const total = candidates.length

  apiLogger.info(
    {
      total,
      filmsNoGraph: filmsNoGraph.length,
      coarseEligible: maybeEligible.length,
    },
    `Generate missing graphs: ${total} candidates (of ${filmsNoGraph.length} films with no graph, ${maybeEligible.length} with 3+ reviews)`
  )

  // ── Step 3: stream progress via SSE as we process each candidate ──
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false

      function send(data: object) {
        if (closed) return
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          )
        } catch {
          closed = true
        }
      }

      // SSE comment line to nudge any buffering proxy to start flushing
      // before the first real event arrives.
      try {
        controller.enqueue(encoder.encode(': ready\n\n'))
      } catch {
        closed = true
      }

      send({ type: 'start', total })

      const results: Array<{
        filmId: string
        title: string
        ok: boolean
        error?: string
      }> = []
      let succeeded = 0
      let failed = 0
      let timedOut = false
      let stoppedAtTitle: string | null = null
      let processedCount = 0

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]

        if (Date.now() > deadline) {
          timedOut = true
          stoppedAtTitle = c.title
          apiLogger.warn(
            { stoppedAtIndex: i, total, filmId: c.id },
            `Generate missing graphs approaching timeout — stopping at ${i + 1}/${total}`
          )
          send({ type: 'timeout', stoppedAtTitle, processed: processedCount, total })
          break
        }

        send({
          type: 'progress',
          n: i + 1,
          total,
          title: c.title,
          filmId: c.id,
        })

        try {
          await generateHybridAndStore(c.id, { force: true, callerPath: 'admin-analyze' })
          await invalidateFilmCache(c.id).catch(() => {})
          results.push({ filmId: c.id, title: c.title, ok: true })
          succeeded++
          send({ type: 'result', filmId: c.id, title: c.title, ok: true })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          results.push({
            filmId: c.id,
            title: c.title,
            ok: false,
            error: message,
          })
          failed++
          send({
            type: 'result',
            filmId: c.id,
            title: c.title,
            ok: false,
            error: message,
          })
          apiLogger.error(
            { err, filmId: c.id, title: c.title },
            'Generate missing graphs: per-film error'
          )
        }

        processedCount++
      }

      // Homepage cache invalidation once at the end — cheap to skip per-film.
      if (succeeded > 0) {
        await invalidateHomepageCache().catch(() => {})
      }

      const durationMs = Date.now() - startTime

      apiLogger.info(
        {
          total,
          processed: processedCount,
          succeeded,
          failed,
          timedOut,
          durationMs,
        },
        `Generate missing graphs complete: ${succeeded}/${processedCount} succeeded${
          timedOut ? ` (timed out at ${stoppedAtTitle})` : ''
        }`
      )

      send({
        type: 'done',
        total,
        processed: processedCount,
        succeeded,
        failed,
        timedOut,
        stoppedAtTitle: timedOut ? stoppedAtTitle : null,
        durationMs,
        results,
      })

      if (!closed) {
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
