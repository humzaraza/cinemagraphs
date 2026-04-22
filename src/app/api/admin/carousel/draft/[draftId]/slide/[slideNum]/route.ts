import { NextRequest } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { renderMiddleSlide, RenderMiddleSlideError } from '@/lib/carousel/render-middle-slide'
import type { MiddleSlideNumber, SlideCopy } from '@/lib/carousel/body-copy-generator'

export const dynamic = 'force-dynamic'

const MAX_HEADLINE_LENGTH = 80

function errorJson(error: string, code: string, status: number) {
  return Response.json({ error, code }, { status })
}

// PATCH a single middle slide's body copy (headline and/or body). Renders the
// slide with the candidate edit first and only persists if render succeeds —
// no transaction needed because the DB write is a single row update.
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

  let body: { headline?: unknown; body?: unknown }
  try {
    body = await request.json()
  } catch {
    return errorJson('Invalid JSON', 'INVALID_JSON', 400)
  }

  const headline = typeof body.headline === 'string' ? body.headline : undefined
  const bodyText = typeof body.body === 'string' ? body.body : undefined
  if (headline === undefined && bodyText === undefined) {
    return errorJson(
      'Request must include at least one of: headline, body',
      'EMPTY_EDIT',
      400,
    )
  }
  if (headline !== undefined && headline.length > MAX_HEADLINE_LENGTH) {
    return errorJson(
      `Headline exceeds ${MAX_HEADLINE_LENGTH} chars`,
      'HEADLINE_TOO_LONG',
      400,
    )
  }

  const draft = await prisma.carouselDraft.findUnique({
    where: { id: draftId },
    select: { id: true, bodyCopyJson: true },
  })
  if (!draft) {
    return errorJson('Draft not found', 'DRAFT_NOT_FOUND', 404)
  }

  const bodyCopyJson = (draft.bodyCopyJson ?? {}) as unknown as Record<string, SlideCopy>
  const currentCopy = bodyCopyJson[String(slideNum)]
  if (!currentCopy) {
    return errorJson(
      `No persisted body copy for slide ${slideNum}`,
      'NO_BODY_COPY',
      404,
    )
  }

  const candidate: SlideCopy = {
    pill: currentCopy.pill,
    headline: headline !== undefined ? headline : currentCopy.headline,
    body: bodyText !== undefined ? bodyText : currentCopy.body,
  }

  // Render first — if the composer throws (e.g. malformed color marker,
  // missing beat), surface the error and leave the DB untouched.
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

  // Render succeeded — now persist the edit.
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
