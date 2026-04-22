import { NextRequest } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { renderMiddleSlide, RenderMiddleSlideError } from '@/lib/carousel/render-middle-slide'
import {
  generateBodyCopyForSlide,
  BodyCopyGenerationError,
  type MiddleSlideNumber,
  type PreviousSlideContext,
  type SlideBeatContext,
  type SlideCopy,
  type SlideOriginalRole,
} from '@/lib/carousel/body-copy-generator'
import { computeDotColor, type DataPoint } from '@/lib/carousel/graph-renderer'
import type { SentimentDataPoint } from '@/lib/types'

export const dynamic = 'force-dynamic'

type StoredSlot = {
  position: number
  kind: string
  originalRole: SlideOriginalRole | null
  beatTimestamp: number | null
  beatScore: number | null
  timestampLabel: string
  collision: boolean
  duplicateTimestamp?: boolean
}

function errorJson(error: string, code: string, status: number) {
  return Response.json({ error, code }, { status })
}

// POST: regenerate body copy (pill + headline + body) for a single middle
// slide (2-7). Uses the currently-persisted beat for the target slot — so if
// the user changed the beat via the picker, the regenerate call writes copy
// for the new beat. The OTHER 5 slides are passed to the AI as voice/pattern
// reference only; they are NOT touched.
//
// Render-then-persist pattern (matches PATCH): the composer runs first with
// the candidate copy; if it throws, the DB is left untouched. On success,
// only bodyCopyJson[slideNum] is written.
//
// aiBodyCopyJson is NEVER written by this route. That field is the baseline
// that Revert restores to, frozen at initial generation. Regenerating should
// still leave Revert enabled and pointing back to the original AI output.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ draftId: string; slideNum: string }> },
) {
  const auth = await requireRole('ADMIN')
  if (!auth.authorized) return auth.errorResponse!

  const { draftId, slideNum: slideNumStr } = await params
  const slideNum = Number.parseInt(slideNumStr, 10)
  if (!Number.isInteger(slideNum) || slideNum < 2 || slideNum > 7) {
    return errorJson(
      `slideNum must be an integer in 2..7, got "${slideNumStr}"`,
      'INVALID_SLIDE',
      400,
    )
  }

  const draft = await prisma.carouselDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      filmId: true,
      bodyCopyJson: true,
      slotSelectionsJson: true,
    },
  })
  if (!draft) {
    return errorJson('Draft not found', 'DRAFT_NOT_FOUND', 404)
  }

  const film = await prisma.film.findUnique({
    where: { id: draft.filmId },
    select: {
      id: true,
      title: true,
      releaseDate: true,
      runtime: true,
      sentimentGraph: {
        select: { overallScore: true, dataPoints: true },
      },
    },
  })
  if (!film) {
    return errorJson('Film not found', 'FILM_NOT_FOUND', 404)
  }
  if (!film.sentimentGraph) {
    return errorJson('Film has no sentiment graph', 'NO_SENTIMENT_GRAPH', 400)
  }
  if (!film.runtime || film.runtime <= 0) {
    return errorJson('Film runtime is missing', 'NO_RUNTIME', 400)
  }

  const rawBeats = (Array.isArray(film.sentimentGraph.dataPoints)
    ? film.sentimentGraph.dataPoints
    : []) as unknown as SentimentDataPoint[]
  const sortedBeats = [...rawBeats].sort((a, b) => a.timeMidpoint - b.timeMidpoint)
  if (sortedBeats.length === 0) {
    return errorJson('Film sentiment graph has no beats', 'NO_BEATS', 400)
  }
  const dataPoints: DataPoint[] = sortedBeats.map((b) => ({ t: b.timeMidpoint, s: b.score }))

  const slots = (Array.isArray(draft.slotSelectionsJson)
    ? draft.slotSelectionsJson
    : []) as unknown as StoredSlot[]
  const targetSlot = slots.find((s) => s.position === slideNum)
  if (!targetSlot || targetSlot.beatTimestamp === null) {
    return errorJson(
      `Slot ${slideNum} has no beat in persisted slotSelections`,
      'SLOT_MISSING',
      404,
    )
  }
  const targetBeat = sortedBeats.find((b) => b.timeMidpoint === targetSlot.beatTimestamp)
  if (!targetBeat) {
    return errorJson(
      `Could not locate beat at t=${targetSlot.beatTimestamp} in sentiment graph`,
      'BEAT_NOT_FOUND',
      500,
    )
  }

  const bodyCopyJson = (draft.bodyCopyJson ?? {}) as unknown as Record<string, SlideCopy>

  const targetSlide: SlideBeatContext = {
    slideNumber: slideNum as MiddleSlideNumber,
    // The renderer composes its own rendered pill (AI pill + timestamp); this
    // seed is only used as a fallback when the AI returns an empty pill.
    pillLabel: bodyCopyJson[String(slideNum)]?.pill ?? '',
    beatTimestamp: targetBeat.timeMidpoint,
    beatScore: targetBeat.score,
    beatColor: computeDotColor(targetBeat.score),
    originalRole: (targetSlot.originalRole ?? 'fallback') as SlideOriginalRole,
    storyBeatName: (targetBeat.labelFull ?? targetBeat.label ?? '').trim(),
  }

  // Collect the other 5 slides (2-7 minus the target) as previous_slides_context.
  // Skip any that are missing persisted body copy — the AI can still work with
  // fewer reference slides. Beats come from persisted slot state so voice and
  // pattern reference reflect the user's current edits.
  const previousSlides: PreviousSlideContext[] = []
  for (let n = 2; n <= 7; n++) {
    if (n === slideNum) continue
    const s = slots.find((x) => x.position === n)
    if (!s || s.beatTimestamp === null) continue
    const beat = sortedBeats.find((b) => b.timeMidpoint === s.beatTimestamp)
    if (!beat) continue
    const copy = bodyCopyJson[String(n)]
    if (!copy) continue
    previousSlides.push({
      slideNumber: n as MiddleSlideNumber,
      beatTimestamp: beat.timeMidpoint,
      beatScore: beat.score,
      beatColor: computeDotColor(beat.score),
      originalRole: (s.originalRole ?? 'fallback') as SlideOriginalRole,
      storyBeatName: (beat.labelFull ?? beat.label ?? '').trim(),
      copy,
    })
  }

  const year = film.releaseDate
    ? new Date(film.releaseDate).getFullYear()
    : new Date().getFullYear()

  let candidate: SlideCopy
  try {
    const result = await generateBodyCopyForSlide({
      filmTitle: film.title,
      filmYear: year,
      runtimeMinutes: film.runtime,
      criticsScore: film.sentimentGraph.overallScore,
      dataPoints,
      slide: targetSlide,
      previousSlides,
    })
    candidate = result.slideCopy
  } catch (err) {
    if (err instanceof BodyCopyGenerationError) {
      return errorJson(err.message, 'AI_GENERATION_FAILED', 500)
    }
    const msg = err instanceof Error ? err.message : 'Unknown AI generation error'
    return errorJson(msg, 'AI_GENERATION_FAILED', 500)
  }

  // Render with the new copy before persisting. If the composer throws (e.g.
  // malformed color marker), leave the DB untouched and surface the error.
  let pngBuffer: Buffer
  try {
    pngBuffer = await renderMiddleSlide({
      draftId,
      slideNum: slideNum as MiddleSlideNumber,
      slideCopyOverride: candidate,
    })
  } catch (err) {
    if (err instanceof RenderMiddleSlideError) {
      return errorJson(err.message, err.code, 500)
    }
    const msg = err instanceof Error ? err.message : 'Unknown composer error'
    return errorJson(msg, 'COMPOSER_FAILED', 500)
  }

  // Render succeeded — persist only bodyCopyJson[slideNum]. Do NOT update
  // aiBodyCopyJson: Revert must keep pointing at the original AI baseline.
  const nextBodyCopy = { ...bodyCopyJson, [String(slideNum)]: candidate }
  await prisma.carouselDraft.update({
    where: { id: draftId },
    data: { bodyCopyJson: nextBodyCopy as unknown as object },
  })

  return Response.json({
    slideNum,
    bodyCopy: candidate,
    pngBase64: pngBuffer.toString('base64'),
  })
}
