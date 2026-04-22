import { NextRequest } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { renderMiddleSlide, RenderMiddleSlideError } from '@/lib/carousel/render-middle-slide'
import { formatTimestamp } from '@/lib/carousel/slot-selection'
import {
  buildConflictMap,
  conflictsForSlot,
  type SlotForConflictCheck,
} from '@/lib/carousel/slot-conflicts'
import type { MiddleSlideNumber } from '@/lib/carousel/body-copy-generator'
import type { SentimentDataPoint } from '@/lib/types'

export const dynamic = 'force-dynamic'

type StoredSlot = {
  position: number
  kind: string
  originalRole: string | null
  beatTimestamp: number | null
  beatScore: number | null
  timestampLabel: string
  collision: boolean
  duplicateTimestamp?: boolean
}

function errorJson(error: string, code: string, status: number) {
  return Response.json({ error, code }, { status })
}

// PATCH a single middle slot's beat. The beat-picker dropdown sends
// { beatIndex } where beatIndex is a 0-based offset into the chronologically
// sorted beats array (the same one render-middle-slide uses).
//
// Render-then-persist pattern (matches the body-copy PATCH): if the composer
// throws, the DB is left untouched. On success, the persisted slot is updated
// with the new beat reference + a freshly-formatted timestampLabel, and the
// `collision` flag is recomputed for ALL middle slots so the persisted state
// reflects post-edit reality.
//
// aiSlotSelectionsJson is never written here — it's the algorithm baseline,
// frozen at draft generation. Reset is the only path that reads it.
//
// Idempotent: when the requested beatIndex already matches the persisted
// beat, the composer is skipped. The response still includes a freshly
// computed conflicts list (other slots may have changed since the last save).
export async function PATCH(
  request: NextRequest,
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

  let body: { beatIndex?: unknown }
  try {
    body = await request.json()
  } catch {
    return errorJson('Invalid JSON', 'INVALID_JSON', 400)
  }

  const beatIndex = typeof body.beatIndex === 'number' ? body.beatIndex : NaN
  if (!Number.isInteger(beatIndex) || beatIndex < 0) {
    return errorJson(
      'beatIndex must be a non-negative integer',
      'INVALID_BEAT_INDEX',
      400,
    )
  }

  const draft = await prisma.carouselDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      filmId: true,
      slotSelectionsJson: true,
    },
  })
  if (!draft) {
    return errorJson('Draft not found', 'DRAFT_NOT_FOUND', 404)
  }

  const film = await prisma.film.findUnique({
    where: { id: draft.filmId },
    select: { sentimentGraph: { select: { dataPoints: true } } },
  })
  if (!film?.sentimentGraph) {
    return errorJson('Film sentiment graph missing', 'NO_SENTIMENT_GRAPH', 400)
  }

  const rawBeats = (Array.isArray(film.sentimentGraph.dataPoints)
    ? film.sentimentGraph.dataPoints
    : []) as unknown as SentimentDataPoint[]
  const sortedBeats = [...rawBeats].sort((a, b) => a.timeMidpoint - b.timeMidpoint)
  if (beatIndex >= sortedBeats.length) {
    return errorJson(
      `beatIndex ${beatIndex} is out of range (0..${sortedBeats.length - 1})`,
      'INVALID_BEAT_INDEX',
      400,
    )
  }

  const slots = (Array.isArray(draft.slotSelectionsJson)
    ? draft.slotSelectionsJson
    : []) as unknown as StoredSlot[]
  const currentSlot = slots.find((s) => s.position === slideNum)
  if (!currentSlot) {
    return errorJson(
      `No persisted slot for slide ${slideNum}`,
      'SLOT_MISSING',
      404,
    )
  }

  const targetBeat = sortedBeats[beatIndex]

  // No-op early return: the requested beat already matches what's persisted.
  // Skip the composer (saves a 200ms+ render) but still return the cached PNG
  // and a fresh conflicts array, since other slots may have shifted.
  if (currentSlot.beatTimestamp === targetBeat.timeMidpoint) {
    const conflicts = conflictsForSlot(
      slots as SlotForConflictCheck[],
      slideNum,
    )
    return Response.json({
      slideNum,
      slotSelection: currentSlot,
      pngBase64: null,
      conflicts,
      noop: true,
    })
  }

  // Render with override first; only persist if it succeeds.
  let pngBuffer: Buffer
  try {
    pngBuffer = await renderMiddleSlide({
      draftId,
      slideNum: slideNum as MiddleSlideNumber,
      beatOverride: { beatIndex },
    })
  } catch (err) {
    if (err instanceof RenderMiddleSlideError) {
      return errorJson(err.message, err.code, 500)
    }
    const msg = err instanceof Error ? err.message : 'Unknown composer error'
    return errorJson(msg, 'COMPOSER_FAILED', 500)
  }

  // Build the new slot entry: keep role/kind/duplicateTimestamp, swap the
  // beat reference + timestampLabel + score. `collision` is recomputed below
  // across the full middle range.
  const newSlot: StoredSlot = {
    ...currentSlot,
    beatTimestamp: targetBeat.timeMidpoint,
    beatScore: targetBeat.score,
    timestampLabel: formatTimestamp(targetBeat.timeMidpoint),
    collision: false, // recomputed below
  }

  const nextSlots: StoredSlot[] = slots.map((s) =>
    s.position === slideNum ? newSlot : s,
  )

  // Recompute the `collision` flag across all middle slots from the post-edit
  // state. Persisting this keeps the field consistent for any consumer that
  // reads slotSelectionsJson without recomputing on the fly.
  const conflictMap = buildConflictMap(nextSlots as SlotForConflictCheck[])
  const finalSlots: StoredSlot[] = nextSlots.map((s) => {
    if (s.position < 2 || s.position > 7) return s
    const conf = conflictMap[s.position] ?? []
    return { ...s, collision: conf.length > 0 }
  })

  await prisma.carouselDraft.update({
    where: { id: draftId },
    data: { slotSelectionsJson: finalSlots as unknown as object },
  })

  // Re-read the persisted slot post-update so the response shows the same
  // shape as the page's local state would after applying the change.
  const persistedSlot = finalSlots.find((s) => s.position === slideNum)!
  const conflicts = conflictsForSlot(
    finalSlots as SlotForConflictCheck[],
    slideNum,
  )

  return Response.json({
    slideNum,
    slotSelection: persistedSlot,
    pngBase64: pngBuffer.toString('base64'),
    conflicts,
    noop: false,
  })
}
