import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
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

const DRAFT_ID = 'draft-1'
const AI_COPY = { pill: 'AI pill', headline: 'AI headline', body: 'AI body' }
const EDITED_COPY = { pill: 'AI pill', headline: 'User headline', body: 'User body' }

function revertRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/carousel/draft/${DRAFT_ID}/slide/3/revert`,
    { method: 'POST' },
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
    bodyCopyJson: { '3': EDITED_COPY },
    aiBodyCopyJson: { '3': AI_COPY },
  })
  mocks.prisma.carouselDraft.update.mockResolvedValue({})
})

describe('POST /api/admin/carousel/draft/[draftId]/slide/[slideNum]/revert', () => {
  it('rejects non-admin callers', async () => {
    mocks.requireRole.mockResolvedValue({
      authorized: false,
      session: null,
      errorResponse: Response.json({ error: 'forbidden' }, { status: 403 }),
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/revert/route'
    )
    const res = await POST(revertRequest(), params(3))
    expect(res.status).toBe(403)
    expect(mocks.prisma.carouselDraft.findUnique).not.toHaveBeenCalled()
  })

  it('returns 400 for out-of-range slide numbers', async () => {
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/revert/route'
    )
    for (const bad of ['1', '8', '0', 'abc']) {
      const res = await POST(revertRequest(), params(bad))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('INVALID_SLIDE')
    }
  })

  it('returns 404 when the draft is missing', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(null)
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/revert/route'
    )
    const res = await POST(revertRequest(), params(3))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('DRAFT_NOT_FOUND')
  })

  it('returns 400 when no AI version is available', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      bodyCopyJson: { '3': EDITED_COPY },
      aiBodyCopyJson: null,
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/revert/route'
    )
    const res = await POST(revertRequest(), params(3))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('NO_AI_VERSION')
  })

  it('writes the AI copy back and returns a fresh PNG on success', async () => {
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/revert/route'
    )
    const res = await POST(revertRequest(), params(3))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.slideNum).toBe(3)
    expect(body.bodyCopy).toEqual(AI_COPY)
    expect(body.pngBase64.length).toBeGreaterThan(0)

    expect(mocks.renderMiddleSlide).toHaveBeenCalledTimes(1)
    expect(mocks.renderMiddleSlide.mock.calls[0][0].slideCopyOverride).toEqual(AI_COPY)

    expect(mocks.prisma.carouselDraft.update).toHaveBeenCalledTimes(1)
    const updateArgs = mocks.prisma.carouselDraft.update.mock.calls[0][0]
    expect(updateArgs.data.bodyCopyJson['3']).toEqual(AI_COPY)
  })

  it('is idempotent — skips the DB write when current copy already matches', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      bodyCopyJson: { '3': AI_COPY },
      aiBodyCopyJson: { '3': AI_COPY },
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/revert/route'
    )
    const res = await POST(revertRequest(), params(3))
    expect(res.status).toBe(200)
    // Render still runs so the caller gets a PNG.
    expect(mocks.renderMiddleSlide).toHaveBeenCalledTimes(1)
    // But no DB write.
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })

  it('surfaces render errors without persisting', async () => {
    mocks.renderMiddleSlide.mockRejectedValue(
      new RenderMiddleSlideError('Slot missing', 'SLOT_MISSING'),
    )
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/revert/route'
    )
    const res = await POST(revertRequest(), params(3))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('SLOT_MISSING')
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })
})
