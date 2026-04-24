import { NextRequest } from 'next/server'
import { Prisma } from '@/generated/prisma/client'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { renderMiddleSlide, RenderMiddleSlideError } from '@/lib/carousel/render-middle-slide'
import { applyMirrorSync, fireAndForgetMirrorRender } from '@/lib/carousel/mirror-sync'
import type { MiddleSlideNumber } from '@/lib/carousel/body-copy-generator'

type Format = '4x5' | '9x16'

export const dynamic = 'force-dynamic'

const TMDB_IMAGE_ORIGIN = 'https://image.tmdb.org/'

function errorJson(error: string, code: string, status: number) {
  return Response.json({ error, code }, { status })
}

// PATCH a single middle slide's backdrop (still). Renders the slide with the
// candidate URL first and only persists if render succeeds — same invariant as
// the body-copy PATCH route.
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

  let body: { stillUrl?: unknown }
  try {
    body = await request.json()
  } catch {
    return errorJson('Invalid JSON', 'INVALID_JSON', 400)
  }

  const rawStillUrl = body.stillUrl
  let stillUrl: string | null
  if (rawStillUrl === null) {
    stillUrl = null
  } else if (
    typeof rawStillUrl === 'string' &&
    rawStillUrl.length > 0 &&
    rawStillUrl.startsWith(TMDB_IMAGE_ORIGIN)
  ) {
    stillUrl = rawStillUrl
  } else {
    return errorJson('Invalid stillUrl', 'INVALID_STILL_URL', 400)
  }

  const draft = await prisma.carouselDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      filmId: true,
      format: true,
      backdropUrl: true,
      slideBackdropsJson: true,
    },
  })
  if (!draft) {
    return errorJson('Draft not found', 'DRAFT_NOT_FOUND', 404)
  }

  // Render first — if the composer throws, surface the error and leave the DB
  // untouched so the caller can retry without a half-applied state.
  let pngBuffer: Buffer
  try {
    pngBuffer = await renderMiddleSlide({
      draftId,
      slideNum: slideNum as MiddleSlideNumber,
      slideBackdropOverride: stillUrl,
    })
  } catch (err) {
    if (err instanceof RenderMiddleSlideError) {
      return errorJson(err.message, err.code, 500)
    }
    const msg = err instanceof Error ? err.message : 'Unknown composer error'
    return errorJson(msg, 'COMPOSER_FAILED', 500)
  }

  const existing = (draft.slideBackdropsJson &&
  typeof draft.slideBackdropsJson === 'object' &&
  !Array.isArray(draft.slideBackdropsJson)
    ? draft.slideBackdropsJson
    : {}) as Record<string, string>
  const nextMap: Record<string, string> = { ...existing }
  if (stillUrl === null) {
    delete nextMap[String(slideNum)]
  } else {
    nextMap[String(slideNum)] = stillUrl
  }
  const nextSlideBackdrops =
    Object.keys(nextMap).length === 0 ? Prisma.DbNull : (nextMap as unknown as object)

  await prisma.carouselDraft.update({
    where: { id: draftId },
    data: { slideBackdropsJson: nextSlideBackdrops },
  })

  const mirrorResult = await applyMirrorSync({
    primaryDraftId: draftId,
    primaryFilmId: draft.filmId,
    primaryFormat: draft.format as Format,
    edit: {
      kind: 'still',
      slideNum: slideNum as MiddleSlideNumber,
      stillUrl,
    },
  })
  if (mirrorResult.status === 'synced' && mirrorResult.mirrorDraftId) {
    fireAndForgetMirrorRender({
      mirrorDraftId: mirrorResult.mirrorDraftId,
      slideNum: slideNum as MiddleSlideNumber,
    })
  }

  return Response.json({
    slideNum,
    stillUrl,
    pngBase64: pngBuffer.toString('base64'),
    mirrorSync: {
      status: mirrorResult.status,
      error: mirrorResult.error ?? null,
    },
  })
}
