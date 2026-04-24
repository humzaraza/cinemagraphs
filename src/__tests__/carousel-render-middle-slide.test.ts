import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RenderMiddleSlideError } from '@/lib/carousel/render-middle-slide'

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

// Three beats, ordered by timeMidpoint. The unsorted ordering on insert
// exercises the sort step inside renderMiddleSlide (sentimentGraph.dataPoints
// is not guaranteed sorted).
const BEATS = [
  {
    timeStart: 50, timeEnd: 60, timeMidpoint: 55,
    score: 4.0, label: 'Drop', confidence: 'high', reviewEvidence: '',
  },
  {
    timeStart: 0, timeEnd: 10, timeMidpoint: 5,
    score: 7.5, label: 'Open', confidence: 'high', reviewEvidence: '',
  },
  {
    timeStart: 100, timeEnd: 110, timeMidpoint: 105,
    score: 9.2, label: 'Peak', labelFull: 'Triumphant peak',
    confidence: 'high', reviewEvidence: '',
  },
]
// Once sorted: index 0 → t=5, index 1 → t=55, index 2 → t=105.

const SLOT_3 = {
  position: 3, kind: 'setup', originalRole: 'setup',
  beatTimestamp: 5, beatScore: 7.5,
  timestampLabel: '5m', collision: false,
}

const SLIDE_COPY_3 = { pill: 'THE SETUP', headline: 'Settles in.', body: 'Body.' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.composeSlide.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
    id: DRAFT_ID,
    filmId: FILM_ID,
    format: '4x5',
    bodyCopyJson: { '3': SLIDE_COPY_3 },
    slotSelectionsJson: [SLOT_3],
    backdropUrl: null,
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

describe('renderMiddleSlide — beatOverride', () => {
  it('renders without override using the persisted slot beat', async () => {
    const { renderMiddleSlide } = await import('@/lib/carousel/render-middle-slide')
    await renderMiddleSlide({ draftId: DRAFT_ID, slideNum: 3 })

    expect(mocks.composeSlide).toHaveBeenCalledTimes(1)
    const arg = mocks.composeSlide.mock.calls[0][0]
    // Sorted beats: t=5 is index 0; renderer adds +1 for the anchor.
    expect(arg.middleContent.highlightBeatIndex).toBe(1)
    // Pill is built from persisted slot.timestampLabel.
    expect(arg.middleContent.pillLabel).toBe('THE SETUP · 5M')
  })

  it('renders with override pointing at a different beat and rebuilds the timestamp label', async () => {
    const { renderMiddleSlide } = await import('@/lib/carousel/render-middle-slide')
    await renderMiddleSlide({
      draftId: DRAFT_ID,
      slideNum: 3,
      beatOverride: { beatIndex: 2 },
    })

    expect(mocks.composeSlide).toHaveBeenCalledTimes(1)
    const arg = mocks.composeSlide.mock.calls[0][0]
    // Sorted index 2 → t=105 → highlightBeatIndex 2+1.
    expect(arg.middleContent.highlightBeatIndex).toBe(3)
    // 105 minutes → "1h 45m" via formatTimestamp; uppercased in the pill.
    expect(arg.middleContent.pillLabel).toBe('THE SETUP · 1H 45M')
  })

  it('throws INVALID_BEAT_INDEX when override is out of bounds', async () => {
    const { renderMiddleSlide } = await import('@/lib/carousel/render-middle-slide')

    await expect(
      renderMiddleSlide({
        draftId: DRAFT_ID,
        slideNum: 3,
        beatOverride: { beatIndex: 99 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BEAT_INDEX' })
    await expect(
      renderMiddleSlide({
        draftId: DRAFT_ID,
        slideNum: 3,
        beatOverride: { beatIndex: -1 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BEAT_INDEX' })
    await expect(
      renderMiddleSlide({
        draftId: DRAFT_ID,
        slideNum: 3,
        beatOverride: { beatIndex: 1.5 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BEAT_INDEX' })

    expect(mocks.composeSlide).not.toHaveBeenCalled()
  })

  it('preserves the SLOT_MISSING error from the no-override path when slot is absent', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue({
      id: DRAFT_ID,
      filmId: FILM_ID,
      format: '4x5',
      bodyCopyJson: { '3': SLIDE_COPY_3 },
      slotSelectionsJson: [],
      backdropUrl: null,
    })
    const { renderMiddleSlide } = await import('@/lib/carousel/render-middle-slide')
    await expect(
      renderMiddleSlide({ draftId: DRAFT_ID, slideNum: 3 }),
    ).rejects.toMatchObject({ code: 'SLOT_MISSING' })
  })

  it('exports RenderMiddleSlideError with the expected shape', () => {
    const e = new RenderMiddleSlideError('boom', 'INVALID_BEAT_INDEX')
    expect(e.message).toBe('boom')
    expect(e.code).toBe('INVALID_BEAT_INDEX')
    expect(e.name).toBe('RenderMiddleSlideError')
  })
})
