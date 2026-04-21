import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Hoisted mocks ──────────────────────────────────────────────
// vi.mock() is hoisted above top-level consts; use vi.hoisted() so the
// factories below can reference the same vi.fn() stubs the tests reset.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  prisma: {
    film: { findUnique: vi.fn() },
    carouselDraft: { findUnique: vi.fn(), upsert: vi.fn() },
  },
  generateBodyCopy: vi.fn(),
  composeSlide: vi.fn(),
  getMovieBackdropUrls: vi.fn(),
}))

vi.mock('@/lib/middleware', () => ({
  requireRole: mocks.requireRole,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: mocks.prisma,
}))

vi.mock('@/lib/carousel/body-copy-generator', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/carousel/body-copy-generator')
  >('@/lib/carousel/body-copy-generator')
  return {
    ...actual,
    generateBodyCopy: mocks.generateBodyCopy,
  }
})

vi.mock('@/lib/carousel/slide-composer', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/carousel/slide-composer')
  >('@/lib/carousel/slide-composer')
  return {
    ...actual,
    composeSlide: mocks.composeSlide,
  }
})

vi.mock('@/lib/tmdb', () => ({
  getMovieBackdropUrls: mocks.getMovieBackdropUrls,
}))

// ── Test fixtures ──────────────────────────────────────────────

const BEATS = [
  { label: 'Opening', labelFull: 'Opening', timeStart: 0, timeEnd: 10, timeMidpoint: 5, score: 7.8, confidence: 'high', reviewEvidence: '' },
  { label: 'Setup', labelFull: 'Setup', timeStart: 10, timeEnd: 60, timeMidpoint: 55, score: 8.1, confidence: 'high', reviewEvidence: '' },
  { label: 'Drop', labelFull: 'Drop', timeStart: 70, timeEnd: 80, timeMidpoint: 75, score: 5.8, confidence: 'high', reviewEvidence: '' },
  { label: 'Recovery', labelFull: 'Recovery', timeStart: 80, timeEnd: 90, timeMidpoint: 85, score: 8.7, confidence: 'high', reviewEvidence: '' },
  { label: 'Peak', labelFull: 'Peak', timeStart: 110, timeEnd: 120, timeMidpoint: 115, score: 9.5, confidence: 'high', reviewEvidence: '' },
  { label: 'Ending', labelFull: 'Ending', timeStart: 150, timeEnd: 157, timeMidpoint: 154, score: 7.4, confidence: 'high', reviewEvidence: '' },
]

const FILM_SHAPE = {
  id: 'film-1',
  tmdbId: 12345,
  title: 'Test Film',
  releaseDate: new Date('2024-01-01'),
  runtime: 157,
  genres: ['Drama'],
  sentimentGraph: {
    overallScore: 8.3,
    dataPoints: BEATS,
  },
}

const SLIDE_COPY = {
  2: { pill: 'Ryland wakes alone', body: 'copy 2' },
  3: { pill: 'Stratt reveals mission', body: 'copy 3' },
  4: { pill: 'Grace forced onto ship', body: 'copy 4' },
  5: { pill: 'Rocky at Tau Ceti', body: 'copy 5' },
  6: { pill: 'Rocky saves Grace', body: 'copy 6' },
  7: { pill: 'Grace teaches children', body: 'copy 7' },
}

const CHARACTERISTICS = {
  dropSeverity: 'moderate' as const,
  recoveryShape: 'sharp' as const,
  peakHeight: 9.5,
  peakIsLate: true,
  redDotCount: 1,
  endingDirection: 'down' as const,
}

function makeJsonRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/carousel/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: admin is authorized
  mocks.requireRole.mockResolvedValue({
    authorized: true,
    session: { user: { id: 'u1', role: 'ADMIN' } },
  })
  mocks.composeSlide.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  mocks.getMovieBackdropUrls.mockResolvedValue([])
  mocks.generateBodyCopy.mockResolvedValue({
    slideCopy: SLIDE_COPY,
    characteristics: CHARACTERISTICS,
    modelUsed: 'claude-sonnet-4-6',
    totalTokens: 1234,
  })
})

describe('POST /api/admin/carousel/draft', () => {
  it('returns 403 when the caller is not an admin', async () => {
    mocks.requireRole.mockResolvedValue({
      authorized: false,
      session: null,
      errorResponse: Response.json({ error: 'Insufficient permissions' }, { status: 403 }),
    })

    const { POST } = await import('@/app/api/admin/carousel/draft/route')
    const res = await POST(makeJsonRequest({ filmId: 'film-1', format: '4x5' }))

    expect(res.status).toBe(403)
    expect(mocks.prisma.film.findUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when the film is missing', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(null)

    const { POST } = await import('@/app/api/admin/carousel/draft/route')
    const res = await POST(makeJsonRequest({ filmId: 'missing', format: '4x5' }))

    expect(res.status).toBe(404)
    expect(mocks.generateBodyCopy).not.toHaveBeenCalled()
    expect(mocks.composeSlide).not.toHaveBeenCalled()
  })

  it('returns a cached draft without calling generateBodyCopy', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(FILM_SHAPE)
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: 'draft-1',
      filmId: 'film-1',
      format: '4x5',
      bodyCopyJson: SLIDE_COPY,
      slotSelectionsJson: [],
      characteristicsJson: CHARACTERISTICS,
      generatedAt: new Date('2026-04-21T10:00:00Z'),
      generatedAtModel: 'claude-sonnet-4-6',
    })

    const { POST } = await import('@/app/api/admin/carousel/draft/route')
    const res = await POST(makeJsonRequest({ filmId: 'film-1', format: '4x5' }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cached).toBe(true)
    expect(body.generatedAt).toBe('2026-04-21T10:00:00.000Z')
    expect(mocks.generateBodyCopy).not.toHaveBeenCalled()
    expect(mocks.prisma.carouselDraft.upsert).not.toHaveBeenCalled()
  })

  it('generates a new draft and upserts when no cache exists', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(FILM_SHAPE)
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(null)
    mocks.prisma.carouselDraft.upsert.mockResolvedValue({
      id: 'draft-1',
      filmId: 'film-1',
      format: '4x5',
      bodyCopyJson: SLIDE_COPY,
      slotSelectionsJson: [],
      characteristicsJson: CHARACTERISTICS,
      generatedAt: new Date('2026-04-21T11:00:00Z'),
      generatedAtModel: 'claude-sonnet-4-6',
    })

    const { POST } = await import('@/app/api/admin/carousel/draft/route')
    const res = await POST(makeJsonRequest({ filmId: 'film-1', format: '4x5' }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cached).toBe(false)
    expect(body.generatedAtModel).toBe('claude-sonnet-4-6')
    expect(mocks.generateBodyCopy).toHaveBeenCalledTimes(1)
    expect(mocks.prisma.carouselDraft.upsert).toHaveBeenCalledTimes(1)
    // Upsert shape
    const upsertArgs = mocks.prisma.carouselDraft.upsert.mock.calls[0][0]
    expect(upsertArgs.where).toEqual({ filmId_format: { filmId: 'film-1', format: '4x5' } })
  })

  it('force: true bypasses the cache and regenerates', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(FILM_SHAPE)
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: 'draft-1',
      filmId: 'film-1',
      format: '4x5',
      bodyCopyJson: SLIDE_COPY,
      slotSelectionsJson: [],
      characteristicsJson: CHARACTERISTICS,
      generatedAt: new Date('2026-04-21T10:00:00Z'),
      generatedAtModel: 'claude-sonnet-4-6',
    })
    mocks.prisma.carouselDraft.upsert.mockResolvedValue({
      id: 'draft-1',
      filmId: 'film-1',
      format: '4x5',
      bodyCopyJson: SLIDE_COPY,
      slotSelectionsJson: [],
      characteristicsJson: CHARACTERISTICS,
      generatedAt: new Date('2026-04-21T12:00:00Z'),
      generatedAtModel: 'claude-sonnet-4-6',
    })

    const { POST } = await import('@/app/api/admin/carousel/draft/route')
    const res = await POST(makeJsonRequest({ filmId: 'film-1', format: '4x5', force: true }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cached).toBe(false)
    expect(mocks.generateBodyCopy).toHaveBeenCalledTimes(1)
    expect(mocks.prisma.carouselDraft.upsert).toHaveBeenCalledTimes(1)
  })

  it('returns exactly 8 slides numbered 1 through 8 with base64 PNGs', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(FILM_SHAPE)
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(null)
    mocks.prisma.carouselDraft.upsert.mockResolvedValue({
      id: 'draft-1',
      filmId: 'film-1',
      format: '4x5',
      bodyCopyJson: SLIDE_COPY,
      slotSelectionsJson: [],
      characteristicsJson: CHARACTERISTICS,
      generatedAt: new Date('2026-04-21T11:00:00Z'),
      generatedAtModel: 'claude-sonnet-4-6',
    })

    const { POST } = await import('@/app/api/admin/carousel/draft/route')
    const res = await POST(makeJsonRequest({ filmId: 'film-1', format: '4x5' }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.slides).toHaveLength(8)
    expect(body.slides.map((s: { slideNumber: number }) => s.slideNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const slide of body.slides) {
      expect(typeof slide.pngBase64).toBe('string')
      expect(slide.pngBase64.length).toBeGreaterThan(0)
      expect(slide.widthPx).toBe(1080)
      expect(slide.heightPx).toBe(1350)
    }
    expect(mocks.composeSlide).toHaveBeenCalledTimes(8)
  })

  it('returns 9:16 dimensions when format is 9x16', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue(FILM_SHAPE)
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(null)
    mocks.prisma.carouselDraft.upsert.mockResolvedValue({
      id: 'draft-1',
      filmId: 'film-1',
      format: '9x16',
      bodyCopyJson: SLIDE_COPY,
      slotSelectionsJson: [],
      characteristicsJson: CHARACTERISTICS,
      generatedAt: new Date('2026-04-21T11:00:00Z'),
      generatedAtModel: 'claude-sonnet-4-6',
    })

    const { POST } = await import('@/app/api/admin/carousel/draft/route')
    const res = await POST(makeJsonRequest({ filmId: 'film-1', format: '9x16' }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.format).toBe('9x16')
    for (const slide of body.slides) {
      expect(slide.widthPx).toBe(1080)
      expect(slide.heightPx).toBe(1920)
    }
  })

  it('returns 400 when format is invalid', async () => {
    const { POST } = await import('@/app/api/admin/carousel/draft/route')
    const res = await POST(makeJsonRequest({ filmId: 'film-1', format: 'square' }))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/format/i)
  })
})
