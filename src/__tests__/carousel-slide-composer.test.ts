import { describe, it, expect } from 'vitest'
import type { DataPoint } from '@/lib/carousel/graph-renderer'
import {
  composeSlide,
  type FilmData,
  type MiddleSlideContent,
} from '@/lib/carousel/slide-composer'

const PHM_DATA: DataPoint[] = [
  { t: 5, s: 7.8 },
  { t: 15, s: 7.2 },
  { t: 25, s: 6.8 },
  { t: 35, s: 7.5 },
  { t: 45, s: 7.9 },
  { t: 55, s: 8.1 },
  { t: 65, s: 6.2 },
  { t: 75, s: 5.8 },
  { t: 85, s: 8.7 },
  { t: 95, s: 9.2 },
  { t: 105, s: 8.9 },
  { t: 115, s: 9.5 },
  { t: 125, s: 8.6 },
  { t: 135, s: 9.1 },
  { t: 145, s: 8.8 },
  { t: 154, s: 7.4 },
]

const PHM_FILM: FilmData = {
  title: 'Project Hail Mary',
  year: 2026,
  runtime: '2h 37m',
  genres: ['Sci-Fi', 'Drama'],
  criticsScore: 8.3,
  dataPoints: PHM_DATA,
  totalRuntimeMinutes: 157,
}

function middleFor(
  pill: string,
  headline: string,
  body: string,
  idx: number,
): MiddleSlideContent {
  return {
    pillLabel: pill,
    headline,
    bodyCopy: body,
    highlightBeatIndex: idx,
  }
}

describe('composeSlide', () => {
  it('slide 1 (hook, 4x5, no middleContent) returns a non-empty Buffer', async () => {
    const png = await composeSlide({
      film: PHM_FILM,
      slideNumber: 1,
      format: '4x5',
    })
    expect(Buffer.isBuffer(png)).toBe(true)
    expect(png.length).toBeGreaterThan(0)
  })

  it('slide 4 (drop, 4x5) with valid middleContent (highlightBeatIndex 8) returns a non-empty Buffer', async () => {
    const png = await composeSlide({
      film: PHM_FILM,
      slideNumber: 4,
      format: '4x5',
      middleContent: middleFor(
        'THE DROP · 1H 15M',
        'Then everything crashes.',
        'At 1h 15m the score bottoms out. The only red dot in the film.',
        8,
      ),
    })
    expect(Buffer.isBuffer(png)).toBe(true)
    expect(png.length).toBeGreaterThan(0)
  })

  it('slide 8 (takeaway, 4x5) returns a non-empty Buffer', async () => {
    const png = await composeSlide({
      film: PHM_FILM,
      slideNumber: 8,
      format: '4x5',
    })
    expect(Buffer.isBuffer(png)).toBe(true)
    expect(png.length).toBeGreaterThan(0)
  })

  it('slide 6 (peak, 9x16) with valid middleContent returns a non-empty Buffer', async () => {
    const png = await composeSlide({
      film: PHM_FILM,
      slideNumber: 6,
      format: '9x16',
      middleContent: middleFor(
        'THE PEAK · 1H 55M',
        "The film's highest moment.",
        'Rocky breaks his spacesuit to save unconscious Ryland. The score hits 9.5.',
        12,
      ),
    })
    expect(Buffer.isBuffer(png)).toBe(true)
    expect(png.length).toBeGreaterThan(0)
  })

  it('throws when slideNumber is 2-7 and middleContent is missing', async () => {
    await expect(
      composeSlide({
        film: PHM_FILM,
        slideNumber: 4,
        format: '4x5',
      }),
    ).rejects.toThrow(/middleContent is required/)
  })

  it('throws when middleContent.highlightBeatIndex is out of range', async () => {
    // PHM_DATA.length = 16; post-anchor valid indices are 0..16.
    await expect(
      composeSlide({
        film: PHM_FILM,
        slideNumber: 4,
        format: '4x5',
        middleContent: middleFor('THE DROP', 'headline', 'body', 99),
      }),
    ).rejects.toThrow(/out of range/)

    await expect(
      composeSlide({
        film: PHM_FILM,
        slideNumber: 4,
        format: '4x5',
        middleContent: middleFor('THE DROP', 'headline', 'body', -1),
      }),
    ).rejects.toThrow(/out of range/)
  })
})
