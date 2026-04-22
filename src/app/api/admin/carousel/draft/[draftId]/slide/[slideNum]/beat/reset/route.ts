import { NextRequest } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { renderMiddleSlide, RenderMiddleSlideError } from '@/lib/carousel/render-middle-slide'
import {
  buildConflictMap,
  conflictsForSlot,
  type SlotForConflictCheck,
} from '@/lib/carousel/slot-conflicts'
import type { MiddleSlideNumber } from '@/lib/carousel/body-copy-generator'

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

// Reset a single middle slot's beat to the algorithm's original pick from
// aiSlotSelectionsJson. Mirrors the body-copy revert endpoint's render-then-
// persist pattern. Idempotent: when current already matches the AI version,
// the DB write is skipped but a fresh render still runs (so the response
// shape stays identical to the change path) and conflicts are returned
// (other slots may have moved since the last save).
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
      slotSelectionsJson: true,
      aiSlotSelectionsJson: true,
    },
  })
  if (!draft) {
    return errorJson('Draft not found', 'DRAFT_NOT_FOUND', 404)
  }

  const aiSlots = (Array.isArray(draft.aiSlotSelectionsJson)
    ? draft.aiSlotSelectionsJson
    : null) as unknown as StoredSlot[] | null
  const aiSlot = aiSlots?.find((s) => s.position === slideNum)
  if (!aiSlot || aiSlot.beatTimestamp === null) {
    return errorJson(
      'No AI version available to reset to',
      'NO_AI_VERSION',
      400,
    )
  }

  const currentSlots = (Array.isArray(draft.slotSelectionsJson)
    ? draft.slotSelectionsJson
    : []) as unknown as StoredSlot[]
  const currentSlot = currentSlots.find((s) => s.position === slideNum)
  const alreadyMatches =
    currentSlot && currentSlot.beatTimestamp === aiSlot.beatTimestamp

  // Build the post-reset slot list — used for conflict computation, and
  // (when alreadyMatches is false) for the persisted state. The non-edited
  // slots are passed through unchanged.
  const nextSlots: StoredSlot[] = currentSlots.map((s) =>
    s.position === slideNum
      ? {
          ...s,
          beatTimestamp: aiSlot.beatTimestamp,
          beatScore: aiSlot.beatScore,
          timestampLabel: aiSlot.timestampLabel,
          // collision recomputed below.
          collision: false,
        }
      : s,
  )
  const conflictMap = buildConflictMap(nextSlots as SlotForConflictCheck[])
  const finalSlots: StoredSlot[] = nextSlots.map((s) => {
    if (s.position < 2 || s.position > 7) return s
    return { ...s, collision: (conflictMap[s.position]?.length ?? 0) > 0 }
  })

  // Render with the AI beat. The beatIndex isn't stored on the slot — we
  // resolve it here by looking up the AI beat's timestamp in the film's
  // sorted beats array.
  const film = await prisma.film.findUnique({
    where: { id: draft.filmId },
    select: { sentimentGraph: { select: { dataPoints: true } } },
  })
  if (!film?.sentimentGraph) {
    return errorJson('Film sentiment graph missing', 'NO_SENTIMENT_GRAPH', 400)
  }
  const rawBeats = (Array.isArray(film.sentimentGraph.dataPoints)
    ? film.sentimentGraph.dataPoints
    : []) as unknown as Array<{ timeMidpoint: number }>
  const sortedBeats = [...rawBeats].sort((a, b) => a.timeMidpoint - b.timeMidpoint)
  const aiBeatIndex = sortedBeats.findIndex(
    (b) => b.timeMidpoint === aiSlot.beatTimestamp,
  )
  if (aiBeatIndex === -1) {
    return errorJson(
      `AI beat at t=${aiSlot.beatTimestamp} not found in current sentiment graph`,
      'BEAT_NOT_FOUND',
      400,
    )
  }

  // We update slotSelectionsJson BEFORE rendering when the slot needs to
  // change, because renderMiddleSlide reads slotSelectionsJson for non-beat
  // slot metadata (kind/originalRole). That said, since we pass beatOverride
  // explicitly and the kind/role are preserved on reset, the persisted state
  // doesn't strictly need to change before render — but we use the override
  // path consistently so behaviour matches the PATCH endpoint.
  let pngBuffer: Buffer
  try {
    pngBuffer = await renderMiddleSlide({
      draftId,
      slideNum: slideNum as MiddleSlideNumber,
      beatOverride: { beatIndex: aiBeatIndex },
    })
  } catch (err) {
    if (err instanceof RenderMiddleSlideError) {
      return errorJson(err.message, err.code, 500)
    }
    const msg = err instanceof Error ? err.message : 'Unknown composer error'
    return errorJson(msg, 'COMPOSER_FAILED', 500)
  }

  if (!alreadyMatches) {
    await prisma.carouselDraft.update({
      where: { id: draftId },
      data: { slotSelectionsJson: finalSlots as unknown as object },
    })
  }

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
  })
}
