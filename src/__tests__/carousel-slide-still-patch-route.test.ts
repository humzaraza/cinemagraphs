import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Prisma } from '@/generated/prisma/client'
import { RenderMiddleSlideError } from '@/lib/carousel/render-middle-slide'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  prisma: {
    carouselDraft: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  renderMiddleSlide: vi.fn(),
  applyMirrorSync: vi.fn(),
  fireAndForgetMirrorRender: vi.fn(),
}))

vi.mock('@/lib/middleware', () => ({
  requireRole: mocks.requireRole,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: mocks.prisma,
}))

vi.mock('@/lib/carousel/render-middle-slide', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/carousel/render-middle-slide')
  >('@/lib/carousel/render-middle-slide')
  return {
    ...actual,
    renderMiddleSlide: mocks.renderMiddleSlide,
  }
})

vi.mock('@/lib/carousel/mirror-sync', () => ({
  applyMirrorSync: mocks.applyMirrorSync,
  fireAndForgetMirrorRender: mocks.fireAndForgetMirrorRender,
}))

const DRAFT_ID = 'draft-1'
const FILM_ID = 'film-1'
const MIRROR_DRAFT_ID = 'draft-mirror'
const VALID_URL = 'https://image.tmdb.org/t/p/w1280/abc.jpg'

function patchRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/carousel/draft/${DRAFT_ID}/slide/3/still`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

function params(slideNum: string | number) {
  return { params: Promise.resolve({ draftId: DRAFT_ID, slideNum: String(slideNum) }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireRole.mockResolvedValue({
    authorized: true,
    session: { user: { id: 'u1', role: 'ADMIN' } },
  })
  mocks.renderMiddleSlide.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
    id: DRAFT_ID,
    filmId: FILM_ID,
    format: '4x5',
    backdropUrl: 'https://image.tmdb.org/t/p/w1280/draft.jpg',
    slideBackdropsJson: null,
  })
  mocks.prisma.carouselDraft.update.mockResolvedValue({})
  mocks.applyMirrorSync.mockResolvedValue({
    status: 'synced',
    mirrorDraftId: MIRROR_DRAFT_ID,
  })
})

describe('PATCH /api/admin/carousel/draft/[draftId]/slide/[slideNum]/still', () => {
  it('rejects non-admin callers and never hits the DB', async () => {
    mocks.requireRole.mockResolvedValue({
      authorized: false,
      session: null,
      errorResponse: Response.json({ error: 'forbidden' }, { status: 403 }),
    })
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/still/route'
    )
    const res = await PATCH(patchRequest({ stillUrl: VALID_URL }), params(3))
    expect(res.status).toBe(403)
    expect(mocks.prisma.carouselDraft.findUnique).not.toHaveBeenCalled()
    expect(mocks.renderMiddleSlide).not.toHaveBeenCalled()
  })

  it('returns 400 when slideNum is outside 2..7', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/still/route'
    )
    for (const bad of ['1', '8', '0', 'abc']) {
      const res = await PATCH(patchRequest({ stillUrl: VALID_URL }), params(bad))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('INVALID_SLIDE')
    }
  })

  it('returns 400 for stillUrl that does not start with the TMDB origin', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/still/route'
    )
    const cases = [
      { stillUrl: 'https://evil.example.com/a.jpg' },
      { stillUrl: 'http://image.tmdb.org/t/p/w1280/a.jpg' },
      { stillUrl: '' },
      { stillUrl: 42 },
      {},
    ]
    for (const body of cases) {
      const res = await PATCH(patchRequest(body), params(3))
      expect(res.status).toBe(400)
      const parsed = await res.json()
      expect(parsed.code).toBe('INVALID_STILL_URL')
    }
    expect(mocks.prisma.carouselDraft.findUnique).not.toHaveBeenCalled()
  })

  it('accepts stillUrl: null as an explicit clear', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      format: '4x5',
      backdropUrl: 'https://image.tmdb.org/t/p/w1280/draft.jpg',
      slideBackdropsJson: { '3': VALID_URL },
    })
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/still/route'
    )
    const res = await PATCH(patchRequest({ stillUrl: null }), params(3))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stillUrl).toBeNull()
    expect(mocks.renderMiddleSlide).toHaveBeenCalledWith(
      expect.objectContaining({ slideBackdropOverride: null }),
    )
  })

  it('returns 404 when the draft is missing', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(null)
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/still/route'
    )
    const res = await PATCH(patchRequest({ stillUrl: VALID_URL }), params(3))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('DRAFT_NOT_FOUND')
    expect(mocks.renderMiddleSlide).not.toHaveBeenCalled()
  })

  it('render failure surfaces the code/status and leaves the DB untouched', async () => {
    mocks.renderMiddleSlide.mockRejectedValue(
      new RenderMiddleSlideError('bang', 'COMPOSER_EXPLODED'),
    )
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/still/route'
    )
    const res = await PATCH(patchRequest({ stillUrl: VALID_URL }), params(3))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('COMPOSER_EXPLODED')
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
    expect(mocks.applyMirrorSync).not.toHaveBeenCalled()
  })

  it('happy path: renders, persists, mirror-syncs, and returns png + status', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/still/route'
    )
    const res = await PATCH(patchRequest({ stillUrl: VALID_URL }), params(3))
    expect(res.status).toBe(200)

    expect(mocks.renderMiddleSlide).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: DRAFT_ID,
        slideNum: 3,
        slideBackdropOverride: VALID_URL,
      }),
    )

    const updateArg = mocks.prisma.carouselDraft.update.mock.calls[0][0] as {
      where: { id: string }
      data: Record<string, unknown>
    }
    expect(updateArg.where).toEqual({ id: DRAFT_ID })
    expect(updateArg.data.slideBackdropsJson).toEqual({ '3': VALID_URL })

    expect(mocks.applyMirrorSync).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryDraftId: DRAFT_ID,
        primaryFilmId: FILM_ID,
        primaryFormat: '4x5',
        edit: { kind: 'still', slideNum: 3, stillUrl: VALID_URL },
      }),
    )
    expect(mocks.fireAndForgetMirrorRender).toHaveBeenCalledWith({
      mirrorDraftId: MIRROR_DRAFT_ID,
      slideNum: 3,
    })

    const body = await res.json()
    expect(body.slideNum).toBe(3)
    expect(body.stillUrl).toBe(VALID_URL)
    expect(typeof body.pngBase64).toBe('string')
    expect(body.pngBase64.length).toBeGreaterThan(0)
    expect(body.mirrorSync).toEqual({ status: 'synced', error: null })
  })

  it('merges into existing slideBackdropsJson without clobbering other slides', async () => {
    const OTHER_URL = 'https://image.tmdb.org/t/p/w1280/other.jpg'
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      format: '4x5',
      backdropUrl: null,
      slideBackdropsJson: { '2': OTHER_URL },
    })
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/still/route'
    )
    const res = await PATCH(patchRequest({ stillUrl: VALID_URL }), params(4))
    expect(res.status).toBe(200)
    const updateArg = mocks.prisma.carouselDraft.update.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(updateArg.data.slideBackdropsJson).toEqual({
      '2': OTHER_URL,
      '4': VALID_URL,
    })
  })

  it('clearing the only remaining still persists Prisma.DbNull, not empty object', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      format: '4x5',
      backdropUrl: null,
      slideBackdropsJson: { '3': VALID_URL },
    })
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/still/route'
    )
    const res = await PATCH(patchRequest({ stillUrl: null }), params(3))
    expect(res.status).toBe(200)
    const updateArg = mocks.prisma.carouselDraft.update.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(updateArg.data.slideBackdropsJson).toBe(Prisma.DbNull)
    expect(updateArg.data.slideBackdropsJson).not.toEqual({})
  })
})
