import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RenderCloserSlideError } from '@/lib/carousel/render-closer-slide'

const mocks = vi.hoisted(() => ({
  prisma: {
    carouselDraft: { findUnique: vi.fn() },
    film: { findUnique: vi.fn() },
  },
  composeSlide: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))

vi.mock('@/lib/carousel/slide-composer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/carousel/slide-composer')>(
    '@/lib/carousel/slide-composer',
  )
  return { ...actual, composeSlide: mocks.composeSlide }
})

const DRAFT_ID = 'draft-1'
const FILM_ID = 'film-1'

// A single well-formed beat is enough — renderCloserSlide only needs dataPoints
// to populate FilmData for the mini graph on slide 8.
const BEATS = [
  {
    timeStart: 0, timeEnd: 10, timeMidpoint: 5,
    score: 7.5, label: 'Open', confidence: 'high', reviewEvidence: '',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.composeSlide.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
    id: DRAFT_ID,
    filmId: FILM_ID,
    format: '4x5',
    backdropUrl: null,
    slideBackdropsJson: null,
  })
  mocks.prisma.film.findUnique.mockResolvedValue({
    id: FILM_ID,
    title: 'Test Film',
    releaseDate: new Date('2026-01-01'),
    runtime: 120,
    genres: ['Drama'],
    sentimentGraph: { overallScore: 7.0, dataPoints: BEATS },
  })
})

describe('renderCloserSlide', () => {
  it('throws DRAFT_NOT_FOUND when the draft is missing', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(null)
    const { renderCloserSlide } = await import('@/lib/carousel/render-closer-slide')
    await expect(renderCloserSlide({ draftId: DRAFT_ID })).rejects.toMatchObject({
      code: 'DRAFT_NOT_FOUND',
      status: 404,
    })
    expect(mocks.composeSlide).not.toHaveBeenCalled()
  })

  it('uses per-slide resolver when no override provided', async () => {
    const PER_SLIDE_URL = 'https://image.tmdb.org/t/p/w1280/per-slide.jpg'
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      format: '4x5',
      backdropUrl: null,
      slideBackdropsJson: { '8': PER_SLIDE_URL },
    })
    const { renderCloserSlide } = await import('@/lib/carousel/render-closer-slide')
    await renderCloserSlide({ draftId: DRAFT_ID })

    expect(mocks.composeSlide).toHaveBeenCalledTimes(1)
    const arg = mocks.composeSlide.mock.calls[0][0]
    expect(arg.backgroundImage).toBe(PER_SLIDE_URL)
  })

  it('slideBackdropOverride (string) takes precedence over resolver', async () => {
    const PER_SLIDE_URL = 'https://image.tmdb.org/t/p/w1280/persisted.jpg'
    const OVERRIDE_URL = 'https://image.tmdb.org/t/p/w1280/unsaved.jpg'
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      format: '4x5',
      backdropUrl: null,
      slideBackdropsJson: { '8': PER_SLIDE_URL },
    })
    const { renderCloserSlide } = await import('@/lib/carousel/render-closer-slide')
    await renderCloserSlide({
      draftId: DRAFT_ID,
      slideBackdropOverride: OVERRIDE_URL,
    })

    const arg = mocks.composeSlide.mock.calls[0][0]
    expect(arg.backgroundImage).toBe(OVERRIDE_URL)
  })

  it('slideBackdropOverride (null) forces draft.backdropUrl fallback', async () => {
    const DRAFT_URL = 'https://image.tmdb.org/t/p/w1280/draft.jpg'
    const PER_SLIDE_URL = 'https://image.tmdb.org/t/p/w1280/persisted.jpg'
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      format: '4x5',
      backdropUrl: DRAFT_URL,
      slideBackdropsJson: { '8': PER_SLIDE_URL },
    })
    const { renderCloserSlide } = await import('@/lib/carousel/render-closer-slide')
    await renderCloserSlide({
      draftId: DRAFT_ID,
      slideBackdropOverride: null,
    })

    const arg = mocks.composeSlide.mock.calls[0][0]
    expect(arg.backgroundImage).toBe(DRAFT_URL)
  })

  it('calls composeSlide with slideNumber: 8', async () => {
    const { renderCloserSlide } = await import('@/lib/carousel/render-closer-slide')
    await renderCloserSlide({ draftId: DRAFT_ID })

    const arg = mocks.composeSlide.mock.calls[0][0]
    expect(arg.slideNumber).toBe(8)
  })

  it('wraps composer failure as COMPOSER_FAILED error', async () => {
    mocks.composeSlide.mockRejectedValue(new Error('kaboom'))
    const { renderCloserSlide } = await import('@/lib/carousel/render-closer-slide')
    await expect(renderCloserSlide({ draftId: DRAFT_ID })).rejects.toMatchObject({
      code: 'COMPOSER_FAILED',
    })
  })

  it('exports RenderCloserSlideError with code/status/name', () => {
    const e = new RenderCloserSlideError('X', 'msg', 404)
    expect(e.message).toBe('msg')
    expect(e.code).toBe('X')
    expect(e.status).toBe(404)
    expect(e.name).toBe('RenderCloserSlideError')
  })
})
