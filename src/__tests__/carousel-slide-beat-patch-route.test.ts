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
    film: {
      findUnique: vi.fn(),
    },
  },
  renderMiddleSlide: vi.fn(),
}))

vi.mock('@/lib/middleware', () => ({ requireRole: mocks.requireRole }))
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/carousel/render-middle-slide', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/carousel/render-middle-slide')
  >('@/lib/carousel/render-middle-slide')
  return { ...actual, renderMiddleSlide: mocks.renderMiddleSlide }
})

const DRAFT_ID = 'draft-1'
const FILM_ID = 'film-1'

// Sorted indices: 0→t=5, 1→t=25, 2→t=50, 3→t=75, 4→t=80 (unused), 5→t=100, 6→t=150.
// t=80 is intentionally NOT assigned to any slot so the "no conflict" test
// has a beat to point at. t=100 IS used by slot 6, exercising the conflict path.
const BEATS = [
  { timeStart: 0, timeEnd: 10, timeMidpoint: 5,   score: 7.5, label: 'Open',     confidence: 'high', reviewEvidence: '' },
  { timeStart: 20, timeEnd: 30, timeMidpoint: 25, score: 6.0, label: 'Setup',    confidence: 'high', reviewEvidence: '' },
  { timeStart: 45, timeEnd: 55, timeMidpoint: 50, score: 4.0, label: 'Drop',     confidence: 'high', reviewEvidence: '' },
  { timeStart: 70, timeEnd: 80, timeMidpoint: 75, score: 6.5, label: 'Recovery', confidence: 'high', reviewEvidence: '' },
  { timeStart: 78, timeEnd: 82, timeMidpoint: 80, score: 5.0, label: 'Mid',     confidence: 'high', reviewEvidence: '' },
  { timeStart: 95, timeEnd: 105, timeMidpoint: 100, score: 9.2, label: 'Peak',  confidence: 'high', reviewEvidence: '' },
  { timeStart: 145, timeEnd: 155, timeMidpoint: 150, score: 7.0, label: 'End',  confidence: 'high', reviewEvidence: '' },
]

function makeSlot(position: number, role: string, t: number, score: number, ts: string) {
  return {
    position, kind: role, originalRole: role,
    beatTimestamp: t, beatScore: score, timestampLabel: ts,
    collision: false, duplicateTimestamp: false,
  }
}

const SLOT_SELECTIONS = [
  { position: 1, kind: 'hook', originalRole: null, beatTimestamp: null, beatScore: null, timestampLabel: '', collision: false },
  makeSlot(2, 'opening', 5, 7.5, '5m'),
  makeSlot(3, 'setup', 25, 6.0, '25m'),
  makeSlot(4, 'drop', 50, 4.0, '50m'),
  makeSlot(5, 'recovery', 75, 6.5, '1h 15m'),
  makeSlot(6, 'peak', 100, 9.2, '1h 40m'),
  makeSlot(7, 'ending', 150, 7.0, '2h 30m'),
  { position: 8, kind: 'takeaway', originalRole: null, beatTimestamp: null, beatScore: null, timestampLabel: '', collision: false },
]

function patchRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/carousel/draft/${DRAFT_ID}/slide/4/beat`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

function params(slideNum: string | number) {
  return {
    params: Promise.resolve({ draftId: DRAFT_ID, slideNum: String(slideNum) }),
  }
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
    slotSelectionsJson: SLOT_SELECTIONS,
  })
  mocks.prisma.carouselDraft.update.mockResolvedValue({})
  mocks.prisma.film.findUnique.mockResolvedValue({
    sentimentGraph: { dataPoints: BEATS },
  })
})

describe('PATCH /api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat', () => {
  it('rejects non-admin callers', async () => {
    mocks.requireRole.mockResolvedValue({
      authorized: false,
      session: null,
      errorResponse: Response.json({ error: 'forbidden' }, { status: 403 }),
    })
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/route'
    )
    const res = await PATCH(patchRequest({ beatIndex: 1 }), params(4))
    expect(res.status).toBe(403)
    expect(mocks.prisma.carouselDraft.findUnique).not.toHaveBeenCalled()
  })

  it('returns 400 for slideNum outside 2..7', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/route'
    )
    for (const bad of ['1', '8', '0', '99', 'abc']) {
      const res = await PATCH(patchRequest({ beatIndex: 1 }), params(bad))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('INVALID_SLIDE')
    }
  })

  it('returns 400 for missing or non-integer beatIndex', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/route'
    )
    for (const bad of [{}, { beatIndex: 'one' }, { beatIndex: -1 }, { beatIndex: 1.5 }]) {
      const res = await PATCH(patchRequest(bad), params(4))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('INVALID_BEAT_INDEX')
    }
  })

  it('returns 400 when beatIndex is past the end of the beats array', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/route'
    )
    // 7 beats → max valid index 6.
    const res = await PATCH(patchRequest({ beatIndex: 7 }), params(4))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID_BEAT_INDEX')
  })

  it('returns 404 when draft is missing', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(null)
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/route'
    )
    const res = await PATCH(patchRequest({ beatIndex: 1 }), params(4))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('DRAFT_NOT_FOUND')
  })

  it('persists new slot, recomputes timestampLabel + score, returns rendered PNG', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/route'
    )
    // Pick beatIndex 4 (t=80, score 5.0) for slot 4 (currently t=50). Unused beat.
    const res = await PATCH(patchRequest({ beatIndex: 4 }), params(4))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.slideNum).toBe(4)
    expect(body.noop).toBe(false)
    expect(body.slotSelection.beatTimestamp).toBe(80)
    expect(body.slotSelection.beatScore).toBe(5.0)
    expect(body.slotSelection.timestampLabel).toBe('1h 20m')
    expect(body.slotSelection.kind).toBe('drop')
    expect(body.slotSelection.originalRole).toBe('drop')
    expect(typeof body.pngBase64).toBe('string')
    expect(body.pngBase64.length).toBeGreaterThan(0)
    expect(body.conflicts).toEqual([])

    expect(mocks.renderMiddleSlide).toHaveBeenCalledTimes(1)
    expect(mocks.renderMiddleSlide.mock.calls[0][0].beatOverride).toEqual({ beatIndex: 4 })

    expect(mocks.prisma.carouselDraft.update).toHaveBeenCalledTimes(1)
    const update = mocks.prisma.carouselDraft.update.mock.calls[0][0]
    expect(update.where).toEqual({ id: DRAFT_ID })
    const persistedSlots = update.data.slotSelectionsJson
    const slot4 = persistedSlots.find((s: { position: number }) => s.position === 4)
    expect(slot4.beatTimestamp).toBe(80)
    // aiSlotSelectionsJson never written.
    expect(update.data.aiSlotSelectionsJson).toBeUndefined()
  })

  it('reports conflicts for OTHER slots that share the new beatTimestamp', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/route'
    )
    // Slot 6 already has t=100. Setting slot 4 to beatIndex 5 (t=100) creates
    // a conflict between 4 and 6. Response.conflicts is OTHER slots → [6].
    const res = await PATCH(patchRequest({ beatIndex: 5 }), params(4))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conflicts).toEqual([6])

    // Persisted state has both slots flagged collision: true.
    const persistedSlots = mocks.prisma.carouselDraft.update.mock.calls[0][0]
      .data.slotSelectionsJson
    const slot4 = persistedSlots.find((s: { position: number }) => s.position === 4)
    const slot6 = persistedSlots.find((s: { position: number }) => s.position === 6)
    expect(slot4.collision).toBe(true)
    expect(slot6.collision).toBe(true)
  })

  it('no-op when beatIndex matches the persisted beat — skips render and DB write', async () => {
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/route'
    )
    // Slot 4's persisted beat is at t=50 → beatIndex 2.
    const res = await PATCH(patchRequest({ beatIndex: 2 }), params(4))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.noop).toBe(true)
    expect(body.pngBase64).toBeNull()
    expect(body.conflicts).toEqual([])

    expect(mocks.renderMiddleSlide).not.toHaveBeenCalled()
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })

  it('does NOT persist when the composer throws', async () => {
    mocks.renderMiddleSlide.mockRejectedValue(
      new RenderMiddleSlideError('Out of range', 'INVALID_BEAT_INDEX'),
    )
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/route'
    )
    const res = await PATCH(patchRequest({ beatIndex: 4 }), params(4))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('INVALID_BEAT_INDEX')
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })

  it('reports COMPOSER_FAILED for non-render errors', async () => {
    mocks.renderMiddleSlide.mockRejectedValue(new Error('kaboom'))
    const { PATCH } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/route'
    )
    const res = await PATCH(patchRequest({ beatIndex: 5 }), params(4))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('COMPOSER_FAILED')
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })
})
