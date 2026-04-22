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
const SLIDE_COPY = {
  '2': { pill: 'Pill two', headline: 'Old H2', body: 'Old body 2' },
  '3': { pill: 'Pill three', headline: 'Old H3', body: 'Old body 3' },
  '4': { pill: 'Pill four', headline: 'Old H4', body: 'Old body 4' },
  '5': { pill: 'Pill five', headline: 'Old H5', body: 'Old body 5' },
  '6': { pill: 'Pill six', headline: 'Old H6', body: 'Old body 6' },
  '7': { pill: 'Pill seven', headline: 'Old H7', body: 'Old body 7' },
}

function patchRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/admin/carousel/draft/${DRAFT_ID}/slide/3`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
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
    bodyCopyJson: SLIDE_COPY,
  })
  mocks.prisma.carouselDraft.update.mockResolvedValue({})
})

describe('PATCH /api/admin/carousel/draft/[draftId]/slide/[slideNum]', () => {
  it('rejects non-admin callers', async () => {
    mocks.requireRole.mockResolvedValue({
      authorized: false,
      session: null,
      errorResponse: Response.json({ error: 'forbidden' }, { status: 403 }),
    })
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/route'
    )
    const res = await PATCH(patchRequest({ headline: 'x' }), params(3))
    expect(res.status).toBe(403)
    expect(mocks.prisma.carouselDraft.findUnique).not.toHaveBeenCalled()
  })

  it('returns 400 when slideNum is outside 2..7', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/route'
    )
    for (const bad of ['1', '8', '0', '99', 'abc']) {
      const res = await PATCH(patchRequest({ headline: 'x' }), params(bad))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('INVALID_SLIDE')
    }
  })

  it('returns 400 when the body is empty', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/route'
    )
    const res = await PATCH(patchRequest({}), params(3))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('EMPTY_EDIT')
  })

  it('returns 400 when the headline exceeds 80 chars', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/route'
    )
    const res = await PATCH(patchRequest({ headline: 'a'.repeat(81) }), params(3))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('HEADLINE_TOO_LONG')
    expect(mocks.renderMiddleSlide).not.toHaveBeenCalled()
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })

  it('returns 404 when the draft does not exist', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(null)
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/route'
    )
    const res = await PATCH(patchRequest({ headline: 'new' }), params(3))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('DRAFT_NOT_FOUND')
  })

  it('returns 404 when the slide has no persisted body copy', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      bodyCopyJson: { '2': SLIDE_COPY['2'] }, // missing 3
    })
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/route'
    )
    const res = await PATCH(patchRequest({ headline: 'new' }), params(3))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('NO_BODY_COPY')
  })

  it('renders first and persists on success, preserving the pill', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/route'
    )
    const res = await PATCH(
      patchRequest({ headline: 'New H3', body: 'New body 3' }),
      params(3),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.slideNum).toBe(3)
    expect(body.bodyCopy).toEqual({
      pill: 'Pill three',
      headline: 'New H3',
      body: 'New body 3',
    })
    expect(typeof body.pngBase64).toBe('string')
    expect(body.pngBase64.length).toBeGreaterThan(0)

    // Render ran with the candidate before DB write.
    expect(mocks.renderMiddleSlide).toHaveBeenCalledTimes(1)
    const renderArgs = mocks.renderMiddleSlide.mock.calls[0][0]
    expect(renderArgs.draftId).toBe(DRAFT_ID)
    expect(renderArgs.slideNum).toBe(3)
    expect(renderArgs.slideCopyOverride).toEqual({
      pill: 'Pill three',
      headline: 'New H3',
      body: 'New body 3',
    })

    // DB persisted the candidate for slide 3 only.
    expect(mocks.prisma.carouselDraft.update).toHaveBeenCalledTimes(1)
    const updateArgs = mocks.prisma.carouselDraft.update.mock.calls[0][0]
    expect(updateArgs.where).toEqual({ id: DRAFT_ID })
    expect(updateArgs.data.bodyCopyJson['3']).toEqual({
      pill: 'Pill three',
      headline: 'New H3',
      body: 'New body 3',
    })
    // Other slides are untouched.
    expect(updateArgs.data.bodyCopyJson['2']).toEqual(SLIDE_COPY['2'])
  })

  it('accepts a headline-only edit without touching body', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/route'
    )
    const res = await PATCH(patchRequest({ headline: 'Only headline' }), params(3))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bodyCopy.body).toBe('Old body 3')
    expect(body.bodyCopy.headline).toBe('Only headline')
  })

  it('returns the render error code and does not write when composer throws', async () => {
    mocks.renderMiddleSlide.mockRejectedValue(
      new RenderMiddleSlideError('Bad color marker', 'BAD_COLOR_MARKER'),
    )
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/route'
    )
    const res = await PATCH(patchRequest({ headline: 'whatever' }), params(3))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('BAD_COLOR_MARKER')
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })

  it('reports COMPOSER_FAILED for non-render errors', async () => {
    mocks.renderMiddleSlide.mockRejectedValue(new Error('kaboom'))
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/route'
    )
    const res = await PATCH(patchRequest({ headline: 'whatever' }), params(3))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('COMPOSER_FAILED')
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })
})
