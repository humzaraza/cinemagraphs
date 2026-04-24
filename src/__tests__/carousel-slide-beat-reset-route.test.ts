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

// Sorted: 0→t=5, 1→t=25, 2→t=50, 3→t=75, 4→t=100, 5→t=150.
const BEATS = [
  { timeStart: 0, timeEnd: 10, timeMidpoint: 5,   score: 7.5, label: 'Open',     confidence: 'high', reviewEvidence: '' },
  { timeStart: 20, timeEnd: 30, timeMidpoint: 25, score: 6.0, label: 'Setup',    confidence: 'high', reviewEvidence: '' },
  { timeStart: 45, timeEnd: 55, timeMidpoint: 50, score: 4.0, label: 'Drop',     confidence: 'high', reviewEvidence: '' },
  { timeStart: 70, timeEnd: 80, timeMidpoint: 75, score: 6.5, label: 'Recovery', confidence: 'high', reviewEvidence: '' },
  { timeStart: 95, timeEnd: 105, timeMidpoint: 100, score: 9.2, label: 'Peak',  confidence: 'high', reviewEvidence: '' },
  { timeStart: 145, timeEnd: 155, timeMidpoint: 150, score: 7.0, label: 'End',  confidence: 'high', reviewEvidence: '' },
]

function makeSlot(position: number, role: string, t: number, score: number, ts: string, collision = false) {
  return {
    position, kind: role, originalRole: role,
    beatTimestamp: t, beatScore: score, timestampLabel: ts,
    collision, duplicateTimestamp: false,
  }
}

// Slot 4 currently edited to t=100 (peak's beat). AI version had t=50.
const CURRENT_SLOTS = [
  { position: 1, kind: 'hook', originalRole: null, beatTimestamp: null, beatScore: null, timestampLabel: '', collision: false },
  makeSlot(2, 'opening', 5, 7.5, '5m'),
  makeSlot(3, 'setup', 25, 6.0, '25m'),
  makeSlot(4, 'drop', 100, 9.2, '1h 40m', true),    // edited; conflicts with slot 6
  makeSlot(5, 'recovery', 75, 6.5, '1h 15m'),
  makeSlot(6, 'peak', 100, 9.2, '1h 40m', true),    // conflicts with slot 4
  makeSlot(7, 'ending', 150, 7.0, '2h 30m'),
  { position: 8, kind: 'takeaway', originalRole: null, beatTimestamp: null, beatScore: null, timestampLabel: '', collision: false },
]
const AI_SLOTS = [
  { position: 1, kind: 'hook', originalRole: null, beatTimestamp: null, beatScore: null, timestampLabel: '', collision: false },
  makeSlot(2, 'opening', 5, 7.5, '5m'),
  makeSlot(3, 'setup', 25, 6.0, '25m'),
  makeSlot(4, 'drop', 50, 4.0, '50m'),    // AI baseline
  makeSlot(5, 'recovery', 75, 6.5, '1h 15m'),
  makeSlot(6, 'peak', 100, 9.2, '1h 40m'),
  makeSlot(7, 'ending', 150, 7.0, '2h 30m'),
  { position: 8, kind: 'takeaway', originalRole: null, beatTimestamp: null, beatScore: null, timestampLabel: '', collision: false },
]

function resetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/carousel/draft/${DRAFT_ID}/slide/4/beat/reset`,
    { method: 'POST' },
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
    slotSelectionsJson: CURRENT_SLOTS,
    aiSlotSelectionsJson: AI_SLOTS,
  })
  mocks.prisma.carouselDraft.update.mockResolvedValue({})
  mocks.prisma.film.findUnique.mockResolvedValue({
    sentimentGraph: { dataPoints: BEATS },
  })
})

describe('POST /api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/reset', () => {
  it('rejects non-admin callers', async () => {
    mocks.requireRole.mockResolvedValue({
      authorized: false,
      session: null,
      errorResponse: Response.json({ error: 'forbidden' }, { status: 403 }),
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/reset/route'
    )
    const res = await POST(resetRequest(), params(4))
    expect(res.status).toBe(403)
  })

  it('returns 400 for slideNum outside 2..7', async () => {
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/reset/route'
    )
    for (const bad of ['1', '8', '0', 'abc']) {
      const res = await POST(resetRequest(), params(bad))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('INVALID_SLIDE')
    }
  })

  it('returns 404 when draft is missing', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(null)
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/reset/route'
    )
    const res = await POST(resetRequest(), params(4))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('DRAFT_NOT_FOUND')
  })

  it('returns 400 when aiSlotSelectionsJson is null', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID, filmId: FILM_ID,
      slotSelectionsJson: CURRENT_SLOTS,
      aiSlotSelectionsJson: null,
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/reset/route'
    )
    const res = await POST(resetRequest(), params(4))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('NO_AI_VERSION')
  })

  it('returns 400 when aiSlotSelectionsJson lacks the requested slide', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID, filmId: FILM_ID,
      slotSelectionsJson: CURRENT_SLOTS,
      aiSlotSelectionsJson: AI_SLOTS.filter((s) => s.position !== 4),
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/reset/route'
    )
    const res = await POST(resetRequest(), params(4))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('NO_AI_VERSION')
  })

  it('resets slot to AI version, returns fresh PNG, recomputes collision flags', async () => {
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/reset/route'
    )
    const res = await POST(resetRequest(), params(4))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.slideNum).toBe(4)
    expect(body.slotSelection.beatTimestamp).toBe(50)
    expect(body.slotSelection.beatScore).toBe(4.0)
    expect(body.slotSelection.timestampLabel).toBe('50m')
    expect(body.slotSelection.collision).toBe(false) // conflict cleared
    expect(body.conflicts).toEqual([])
    expect(typeof body.pngBase64).toBe('string')

    expect(mocks.renderMiddleSlide).toHaveBeenCalledTimes(1)
    expect(mocks.renderMiddleSlide.mock.calls[0][0].beatOverride).toEqual({ beatIndex: 2 })

    expect(mocks.prisma.carouselDraft.update).toHaveBeenCalledTimes(1)
    const update = mocks.prisma.carouselDraft.update.mock.calls[0][0]
    const persistedSlots = update.data.slotSelectionsJson
    const slot4 = persistedSlots.find((s: { position: number }) => s.position === 4)
    const slot6 = persistedSlots.find((s: { position: number }) => s.position === 6)
    expect(slot4.beatTimestamp).toBe(50)
    expect(slot4.collision).toBe(false)
    expect(slot6.collision).toBe(false) // conflict cleared on slot 6 too
    // aiSlotSelectionsJson is never written.
    expect(update.data.aiSlotSelectionsJson).toBeUndefined()
  })

  it('idempotent — when current already matches AI, skips DB write but still renders', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID, filmId: FILM_ID,
      slotSelectionsJson: AI_SLOTS, // current === AI
      aiSlotSelectionsJson: AI_SLOTS,
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/reset/route'
    )
    const res = await POST(resetRequest(), params(4))
    expect(res.status).toBe(200)
    expect(mocks.renderMiddleSlide).toHaveBeenCalledTimes(1)
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })

  it('reports conflicts in the response when reset causes a conflict', async () => {
    // Construct: AI says slot 4 should be at t=75 (slot 5's beat). Currently
    // slot 4 is at t=100. Reset would create a conflict between slot 4 and 5.
    const aiWithConflict = AI_SLOTS.map((s) =>
      s.position === 4
        ? { ...s, beatTimestamp: 75, beatScore: 6.5, timestampLabel: '1h 15m' }
        : s,
    )
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID, filmId: FILM_ID,
      slotSelectionsJson: CURRENT_SLOTS,
      aiSlotSelectionsJson: aiWithConflict,
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/reset/route'
    )
    const res = await POST(resetRequest(), params(4))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conflicts).toEqual([5])
  })

  it('does NOT persist when the composer throws', async () => {
    mocks.renderMiddleSlide.mockRejectedValue(
      new RenderMiddleSlideError('Slot missing', 'SLOT_MISSING'),
    )
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/beat/reset/route'
    )
    const res = await POST(resetRequest(), params(4))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('SLOT_MISSING')
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })
})
