import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { RenderMiddleSlideError } from '@/lib/carousel/render-middle-slide'
import { BodyCopyGenerationError } from '@/lib/carousel/body-copy-generator'

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
  generateBodyCopyForSlide: vi.fn(),
  applyMirrorSync: vi.fn(),
  fireAndForgetMirrorRender: vi.fn(),
}))

vi.mock('@/lib/middleware', () => ({ requireRole: mocks.requireRole }))
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))

vi.mock('@/lib/carousel/render-middle-slide', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/carousel/render-middle-slide')
  >('@/lib/carousel/render-middle-slide')
  return { ...actual, renderMiddleSlide: mocks.renderMiddleSlide }
})

vi.mock('@/lib/carousel/body-copy-generator', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/carousel/body-copy-generator')
  >('@/lib/carousel/body-copy-generator')
  return { ...actual, generateBodyCopyForSlide: mocks.generateBodyCopyForSlide }
})

vi.mock('@/lib/carousel/mirror-sync', () => ({
  applyMirrorSync: mocks.applyMirrorSync,
  fireAndForgetMirrorRender: mocks.fireAndForgetMirrorRender,
}))

const DRAFT_ID = 'draft-1'
const FILM_ID = 'film-1'

const BEATS = [
  { timeStart: 0, timeEnd: 10, timeMidpoint: 5, score: 7.5, label: 'Open', labelFull: 'Film opens', confidence: 'high', reviewEvidence: '' },
  { timeStart: 20, timeEnd: 30, timeMidpoint: 25, score: 6.0, label: 'Setup', labelFull: 'Setup complete', confidence: 'high', reviewEvidence: '' },
  { timeStart: 45, timeEnd: 55, timeMidpoint: 50, score: 4.0, label: 'Drop', labelFull: 'The floor drops out', confidence: 'high', reviewEvidence: '' },
  { timeStart: 70, timeEnd: 80, timeMidpoint: 75, score: 6.5, label: 'Recovery', labelFull: 'Recovery begins', confidence: 'high', reviewEvidence: '' },
  { timeStart: 95, timeEnd: 105, timeMidpoint: 100, score: 9.2, label: 'Peak', labelFull: 'The peak arrives', confidence: 'high', reviewEvidence: '' },
  { timeStart: 145, timeEnd: 155, timeMidpoint: 150, score: 7.0, label: 'End', labelFull: 'The ending', confidence: 'high', reviewEvidence: '' },
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

const AI_COPY: Record<string, { pill: string; headline: string; body: string }> = {
  '2': { pill: 'AI pill 2', headline: 'AI h2.', body: 'AI body 2 {{gold:7.5}}.' },
  '3': { pill: 'AI pill 3', headline: 'AI h3.', body: 'AI body 3 {{gold:6.0}}.' },
  '4': { pill: 'AI pill 4', headline: 'AI h4.', body: 'AI body 4 {{red:4.0}}.' },
  '5': { pill: 'AI pill 5', headline: 'AI h5.', body: 'AI body 5 {{gold:6.5}}.' },
  '6': { pill: 'AI pill 6', headline: 'AI h6.', body: 'AI body 6 {{teal:9.2}}.' },
  '7': { pill: 'AI pill 7', headline: 'AI h7.', body: 'AI body 7 {{gold:7.0}}.' },
}

const EDITED_COPY: Record<string, { pill: string; headline: string; body: string }> = {
  '2': { pill: 'AI pill 2', headline: 'User h2.', body: 'User body 2 {{gold:7.5}}.' },
  '3': { pill: 'AI pill 3', headline: 'AI h3.', body: 'AI body 3 {{gold:6.0}}.' },
  '4': { pill: 'AI pill 4', headline: 'User h4.', body: 'User body 4 {{red:4.0}}.' },
  '5': { pill: 'AI pill 5', headline: 'AI h5.', body: 'AI body 5 {{gold:6.5}}.' },
  '6': { pill: 'AI pill 6', headline: 'AI h6.', body: 'AI body 6 {{teal:9.2}}.' },
  '7': { pill: 'AI pill 7', headline: 'AI h7.', body: 'AI body 7 {{gold:7.0}}.' },
}

const REGEN_CANDIDATE = {
  pill: 'Regenerated pill 4',
  headline: 'Regenerated h4.',
  body: 'Regenerated body 4 at {{red:4.0}}.',
}

function regenerateRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/carousel/draft/${DRAFT_ID}/slide/4/regenerate`,
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
  mocks.generateBodyCopyForSlide.mockResolvedValue({
    slideCopy: REGEN_CANDIDATE,
    characteristics: {
      dropSeverity: 'dramatic',
      recoveryShape: 'gradual',
      peakHeight: 9.2,
      peakIsLate: true,
      redDotCount: 1,
      endingDirection: 'flat',
    },
    modelUsed: 'claude-sonnet-4-6',
    totalTokens: 1234,
  })
  mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
    id: DRAFT_ID,
    filmId: FILM_ID,
    bodyCopyJson: EDITED_COPY,
    slotSelectionsJson: SLOT_SELECTIONS,
    staleBodyCopySlots: [],
  })
  mocks.prisma.carouselDraft.update.mockResolvedValue({})
  mocks.prisma.film.findUnique.mockResolvedValue({
    id: FILM_ID,
    title: 'Test Film',
    releaseDate: new Date('2025-04-15'),
    runtime: 157,
    sentimentGraph: { overallScore: 7.8, dataPoints: BEATS },
  })
})

describe('POST /api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate', () => {
  it('rejects non-admin callers', async () => {
    mocks.requireRole.mockResolvedValue({
      authorized: false,
      session: null,
      errorResponse: Response.json({ error: 'forbidden' }, { status: 403 }),
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    const res = await POST(regenerateRequest(), params(4))
    expect(res.status).toBe(403)
    expect(mocks.prisma.carouselDraft.findUnique).not.toHaveBeenCalled()
    expect(mocks.generateBodyCopyForSlide).not.toHaveBeenCalled()
  })

  it('returns 400 for out-of-range slide numbers', async () => {
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    for (const bad of ['1', '8', '0', 'abc']) {
      const res = await POST(regenerateRequest(), params(bad))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('INVALID_SLIDE')
    }
  })

  it('returns 404 when the draft is missing', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(null)
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    const res = await POST(regenerateRequest(), params(4))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('DRAFT_NOT_FOUND')
    expect(mocks.generateBodyCopyForSlide).not.toHaveBeenCalled()
  })

  it('returns 404 when the film is missing', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(null)
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    const res = await POST(regenerateRequest(), params(4))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('FILM_NOT_FOUND')
  })

  it('returns 400 when the film has no sentiment graph', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({
      id: FILM_ID,
      title: 'Test Film',
      releaseDate: new Date('2025-04-15'),
      runtime: 157,
      sentimentGraph: null,
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    const res = await POST(regenerateRequest(), params(4))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('NO_SENTIMENT_GRAPH')
  })

  it('returns 400 when the film has no runtime', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({
      id: FILM_ID,
      title: 'Test Film',
      releaseDate: new Date('2025-04-15'),
      runtime: null,
      sentimentGraph: { overallScore: 7.8, dataPoints: BEATS },
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    const res = await POST(regenerateRequest(), params(4))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('NO_RUNTIME')
  })

  it('returns 400 when the film has no beats', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({
      id: FILM_ID,
      title: 'Test Film',
      releaseDate: new Date('2025-04-15'),
      runtime: 157,
      sentimentGraph: { overallScore: 7.8, dataPoints: [] },
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    const res = await POST(regenerateRequest(), params(4))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('NO_BEATS')
  })

  it('returns 404 when the target slot has no beat in persisted slotSelections', async () => {
    const brokenSlots = SLOT_SELECTIONS.map((s) =>
      s.position === 4 ? { ...s, beatTimestamp: null, beatScore: null } : s,
    )
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      bodyCopyJson: EDITED_COPY,
      slotSelectionsJson: brokenSlots,
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    const res = await POST(regenerateRequest(), params(4))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('SLOT_MISSING')
  })

  it('returns 500 AI_GENERATION_FAILED when the generator throws', async () => {
    mocks.generateBodyCopyForSlide.mockRejectedValue(
      new BodyCopyGenerationError('forbidden dash character'),
    )
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    const res = await POST(regenerateRequest(), params(4))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('AI_GENERATION_FAILED')
    expect(mocks.renderMiddleSlide).not.toHaveBeenCalled()
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })

  it('returns 500 and does not persist when the composer throws after AI succeeds', async () => {
    mocks.renderMiddleSlide.mockRejectedValue(
      new RenderMiddleSlideError('Slot missing', 'SLOT_MISSING'),
    )
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    const res = await POST(regenerateRequest(), params(4))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('SLOT_MISSING')
    expect(mocks.prisma.carouselDraft.update).not.toHaveBeenCalled()
  })

  it('returns the new copy + png, persists only bodyCopyJson[slideNum], never touches aiBodyCopyJson', async () => {
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    const res = await POST(regenerateRequest(), params(4))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.slideNum).toBe(4)
    expect(body.bodyCopy).toEqual({ ...REGEN_CANDIDATE, manuallyEdited: false })
    expect(body.pngBase64.length).toBeGreaterThan(0)

    expect(mocks.generateBodyCopyForSlide).toHaveBeenCalledTimes(1)
    expect(mocks.renderMiddleSlide).toHaveBeenCalledTimes(1)
    expect(mocks.renderMiddleSlide.mock.calls[0][0]).toMatchObject({
      draftId: DRAFT_ID,
      slideNum: 4,
      slideCopyOverride: { ...REGEN_CANDIDATE, manuallyEdited: false },
    })

    expect(mocks.prisma.carouselDraft.update).toHaveBeenCalledTimes(1)
    const updateArgs = mocks.prisma.carouselDraft.update.mock.calls[0][0]
    // bodyCopyJson has the new copy at slide 4, preserves all other entries.
    expect(updateArgs.data.bodyCopyJson['4']).toEqual({ ...REGEN_CANDIDATE, manuallyEdited: false })
    expect(updateArgs.data.bodyCopyJson['2']).toEqual(EDITED_COPY['2'])
    expect(updateArgs.data.bodyCopyJson['7']).toEqual(EDITED_COPY['7'])
    // aiBodyCopyJson is NEVER in the update payload.
    expect(updateArgs.data).not.toHaveProperty('aiBodyCopyJson')
  })

  it('passes the target slide and previous-5 slides to the generator, using persisted beats', async () => {
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    await POST(regenerateRequest(), params(4))

    expect(mocks.generateBodyCopyForSlide).toHaveBeenCalledTimes(1)
    const callArgs = mocks.generateBodyCopyForSlide.mock.calls[0][0]

    expect(callArgs.filmTitle).toBe('Test Film')
    expect(callArgs.runtimeMinutes).toBe(157)
    expect(callArgs.criticsScore).toBe(7.8)

    // Target slide uses the persisted beat (t=50, score=4.0) and full storyBeatName.
    expect(callArgs.slide.slideNumber).toBe(4)
    expect(callArgs.slide.beatTimestamp).toBe(50)
    expect(callArgs.slide.beatScore).toBe(4.0)
    expect(callArgs.slide.originalRole).toBe('drop')
    expect(callArgs.slide.storyBeatName).toBe('The floor drops out')
    expect(callArgs.slide.beatColor).toBe('red')

    // previousSlides contains the other 5 (slide 2, 3, 5, 6, 7), each with
    // its persisted copy attached. Target slide 4 must NOT be in the list.
    const previousSlideNumbers = callArgs.previousSlides.map((p: { slideNumber: number }) => p.slideNumber)
    expect(previousSlideNumbers.sort()).toEqual([2, 3, 5, 6, 7])

    const prev2 = callArgs.previousSlides.find((p: { slideNumber: number }) => p.slideNumber === 2)
    expect(prev2.copy).toEqual(EDITED_COPY['2'])
    expect(prev2.beatTimestamp).toBe(5)
    expect(prev2.storyBeatName).toBe('Film opens')
  })

  it('uses the persisted beat even after a beat-pick change (does not fall back to AI baseline)', async () => {
    // Simulate a beat-pick change that moved slot 4 from t=50 to t=75 (peak-era score).
    const overriddenSlots = SLOT_SELECTIONS.map((s) =>
      s.position === 4 ? { ...s, beatTimestamp: 75, beatScore: 6.5, timestampLabel: '1h 15m' } : s,
    )
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      bodyCopyJson: EDITED_COPY,
      slotSelectionsJson: overriddenSlots,
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    await POST(regenerateRequest(), params(4))

    const callArgs = mocks.generateBodyCopyForSlide.mock.calls[0][0]
    // Generator sees the NEW beat, not the old slot-4 beat.
    expect(callArgs.slide.beatTimestamp).toBe(75)
    expect(callArgs.slide.beatScore).toBe(6.5)
    expect(callArgs.slide.storyBeatName).toBe('Recovery begins')
  })

  it('does not pass a previous-slide entry when that slide has no persisted body copy', async () => {
    // Missing slide 3 copy — should be skipped from previousSlides.
    const partialCopy = { ...EDITED_COPY }
    delete (partialCopy as Record<string, unknown>)['3']
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      bodyCopyJson: partialCopy,
      slotSelectionsJson: SLOT_SELECTIONS,
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    await POST(regenerateRequest(), params(4))

    const callArgs = mocks.generateBodyCopyForSlide.mock.calls[0][0]
    const numbers = callArgs.previousSlides.map((p: { slideNumber: number }) => p.slideNumber).sort()
    expect(numbers).toEqual([2, 5, 6, 7])
  })

  it('persists candidate with manuallyEdited: false', async () => {
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    await POST(regenerateRequest(), params(4))
    const updateArgs = mocks.prisma.carouselDraft.update.mock.calls[0][0]
    expect(updateArgs.data.bodyCopyJson['4'].manuallyEdited).toBe(false)
  })

  it('removes the target slot from staleBodyCopySlots when present', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      bodyCopyJson: EDITED_COPY,
      slotSelectionsJson: SLOT_SELECTIONS,
      staleBodyCopySlots: [2, 4, 6],
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    await POST(regenerateRequest(), params(4))
    const updateArgs = mocks.prisma.carouselDraft.update.mock.calls[0][0]
    expect(updateArgs.data.staleBodyCopySlots).toEqual([2, 6])
  })

  it('omits staleBodyCopySlots from update payload when target is not in the list', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      bodyCopyJson: EDITED_COPY,
      slotSelectionsJson: SLOT_SELECTIONS,
      staleBodyCopySlots: [2, 6],
    })
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    await POST(regenerateRequest(), params(4))
    const updateArgs = mocks.prisma.carouselDraft.update.mock.calls[0][0]
    expect(updateArgs.data).not.toHaveProperty('staleBodyCopySlots')
  })

  it('never calls mirror-sync (regenerate is per-format)', async () => {
    const { POST } = await import(
      '@/app/api/admin/carousel/draft/[draftId]/slide/[slideNum]/regenerate/route'
    )
    await POST(regenerateRequest(), params(4))
    expect(mocks.applyMirrorSync).not.toHaveBeenCalled()
    expect(mocks.fireAndForgetMirrorRender).not.toHaveBeenCalled()
  })
})
