import { NextRequest } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { renderMiddleSlide, RenderMiddleSlideError } from '@/lib/carousel/render-middle-slide'
import { slideCopyEqual } from '@/lib/carousel/body-copy-edit'
import type { MiddleSlideNumber, SlideCopy } from '@/lib/carousel/body-copy-generator'

export const dynamic = 'force-dynamic'

function errorJson(error: string, code: string, status: number) {
  return Response.json({ error, code }, { status })
}

// Revert a single middle slide's body copy to the persisted AI-original
// version (aiBodyCopyJson[slideNum]). Returns the freshly-rendered PNG.
// Idempotent: when the current body copy already matches the AI version, the
// DB update is skipped; the PNG is still rendered so the response shape stays
// consistent with PATCH.
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
    select: { id: true, bodyCopyJson: true, aiBodyCopyJson: true },
  })
  if (!draft) {
    return errorJson('Draft not found', 'DRAFT_NOT_FOUND', 404)
  }

  const aiBodyCopyJson = (draft.aiBodyCopyJson ?? null) as Record<string, SlideCopy> | null
  const aiCopy = aiBodyCopyJson ? aiBodyCopyJson[String(slideNum)] : undefined
  if (!aiCopy) {
    return errorJson(
      'No AI version available to revert to',
      'NO_AI_VERSION',
      400,
    )
  }

  const bodyCopyJson = (draft.bodyCopyJson ?? {}) as unknown as Record<string, SlideCopy>
  const currentCopy = bodyCopyJson[String(slideNum)]
  const alreadyMatches = currentCopy && slideCopyEqual(currentCopy, aiCopy)

  let pngBuffer: Buffer
  try {
    pngBuffer = await renderMiddleSlide({
      draftId,
      slideNum: slideNum as MiddleSlideNumber,
      slideCopyOverride: aiCopy,
    })
  } catch (err) {
    if (err instanceof RenderMiddleSlideError) {
      return errorJson(err.message, err.code, 500)
    }
    const msg = err instanceof Error ? err.message : 'Unknown composer error'
    return errorJson(msg, 'COMPOSER_FAILED', 500)
  }

  // Skip the DB write when nothing actually changed.
  if (!alreadyMatches) {
    const nextBodyCopy = { ...bodyCopyJson, [String(slideNum)]: aiCopy }
    await prisma.carouselDraft.update({
      where: { id: draftId },
      data: { bodyCopyJson: nextBodyCopy as unknown as object },
    })
  }

  return Response.json({
    slideNum,
    bodyCopy: aiCopy,
    pngBase64: pngBuffer.toString('base64'),
  })
}
