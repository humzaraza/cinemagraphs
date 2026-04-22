import { describe, it, expect } from 'vitest'
import { dotRadiusFor, marginsFor, prependNeutralAnchor, type DataPoint } from '@/lib/carousel/graph-renderer'
import {
  BodyCopyParseError,
  computeLabelWidth,
  computeScoreLabelPosition,
  composeSlide,
  parseBodyCopyTokens,
  type FilmData,
  type MiddleSlideContent,
  type ScoreLabelPositionInput,
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

describe('parseBodyCopyTokens', () => {
  it('returns a single null-colored segment when there are no markers', () => {
    expect(parseBodyCopyTokens('plain text with no markers')).toEqual([
      { text: 'plain text with no markers', color: null },
    ])
  })

  it('parses a single teal marker mid-sentence', () => {
    expect(parseBodyCopyTokens('The score hits {{teal:9.5}}.')).toEqual([
      { text: 'The score hits ', color: null },
      { text: '9.5', color: 'teal' },
      { text: '.', color: null },
    ])
  })

  it('parses multiple markers with different colors', () => {
    expect(
      parseBodyCopyTokens('From {{red:5.8}} to {{teal:8.7}} in ten minutes.'),
    ).toEqual([
      { text: 'From ', color: null },
      { text: '5.8', color: 'red' },
      { text: ' to ', color: null },
      { text: '8.7', color: 'teal' },
      { text: ' in ten minutes.', color: null },
    ])
  })

  it('parses a gold marker', () => {
    expect(parseBodyCopyTokens('{{gold:7.4}} is a holding pattern.')).toEqual([
      { text: '7.4', color: 'gold' },
      { text: ' is a holding pattern.', color: null },
    ])
  })

  it('returns [] for an empty string', () => {
    expect(parseBodyCopyTokens('')).toEqual([])
  })

  it('throws BodyCopyParseError on an unterminated marker', () => {
    expect(() => parseBodyCopyTokens('The score hits {{teal:9.5.')).toThrow(
      BodyCopyParseError,
    )
  })

  it('throws BodyCopyParseError on an invalid color keyword', () => {
    expect(() => parseBodyCopyTokens('{{blue:9.5}}')).toThrow(BodyCopyParseError)
  })

  it('throws BodyCopyParseError on a marker missing a colon', () => {
    expect(() => parseBodyCopyTokens('{{teal9.5}}')).toThrow(BodyCopyParseError)
  })

  it('throws BodyCopyParseError on a marker with an empty value', () => {
    expect(() => parseBodyCopyTokens('{{teal:}}')).toThrow(BodyCopyParseError)
  })
})

describe('composeSlide with color-tokenized body copy', () => {
  it('slide 4 with a {{red:5.8}} marker renders without error', async () => {
    const png = await composeSlide({
      film: PHM_FILM,
      slideNumber: 4,
      format: '4x5',
      middleContent: middleFor(
        'THE DROP \u00b7 1H 15M',
        'Then everything crashes.',
        'At 1h 15m the score bottoms out at {{red:5.8}}. The only red dot in the film.',
        8,
      ),
    })
    expect(Buffer.isBuffer(png)).toBe(true)
    expect(png.length).toBeGreaterThan(0)
  })

  it('slide 5 with two markers of different colors renders without error', async () => {
    const png = await composeSlide({
      film: PHM_FILM,
      slideNumber: 5,
      format: '9x16',
      middleContent: middleFor(
        'FIRST CONTACT \u00b7 1H 25M',
        'Rocky arrives.',
        'A jump from {{red:5.8}} to {{teal:8.7}} in ten minutes.',
        9,
      ),
    })
    expect(Buffer.isBuffer(png)).toBe(true)
    expect(png.length).toBeGreaterThan(0)
  })

  it('propagates BodyCopyParseError when body copy has a malformed marker', async () => {
    await expect(
      composeSlide({
        film: PHM_FILM,
        slideNumber: 4,
        format: '4x5',
        middleContent: middleFor(
          'THE DROP',
          'headline',
          'The score hits {{purple:5.8}}.',
          8,
        ),
      }),
    ).rejects.toThrow(BodyCopyParseError)
  })
})

// Kill Bill Vol. 1 — synthetic beat fixture. Representative of an action
// film with large, rapid score swings (intro peak → midact drop → climactic
// House of Blue Leaves peak → cool-down). Chosen because Kill Bill slides
// 3/6/7 were called out as failing the pre-C4.3 quadrant positioner.
const KILL_BILL_DATA: DataPoint[] = [
  { t: 4, s: 8.5 },
  { t: 12, s: 8.0 },
  { t: 22, s: 7.3 },
  { t: 30, s: 9.0 },
  { t: 40, s: 6.5 },
  { t: 50, s: 8.8 },
  { t: 60, s: 7.5 },
  { t: 72, s: 6.0 },
  { t: 82, s: 9.5 },
  { t: 95, s: 9.8 },
  { t: 108, s: 8.5 },
]
const KILL_BILL_RUNTIME = 111

// Build the picker input for a given format + beat index, using the same
// sX/sY math renderGraph uses internally. Mirrors what composeMiddleSlide
// passes at render time.
function buildPickerInput(
  data: DataPoint[],
  totalRuntime: number,
  format: '4x5' | '9x16',
  beatIndex: number,
  labelSize: number,
): ScoreLabelPositionInput {
  const points = prependNeutralAnchor(data)
  const canvas = format === '4x5' ? { w: 960, h: 540 } : { w: 1000, h: 1100 }
  const margins = marginsFor(format)
  const plotW = canvas.w - margins.left - margins.right
  const plotH = canvas.h - margins.top - margins.bottom
  const scores = points.map((p) => p.s)
  const sMin = Math.max(1, Math.floor(Math.min(...scores)) - 1)
  const sMax = Math.min(10, Math.ceil(Math.max(...scores)) + 1)
  const ySpan = sMax - sMin
  const sX = (t: number) => margins.left + (t / totalRuntime) * plotW
  const sY = (s: number) => margins.top + ((sMax - s) / ySpan) * plotH
  const dotPositions = points.map((p) => ({ x: sX(p.t), y: sY(p.s) }))
  const dot = dotPositions[beatIndex]
  const score = points[beatIndex].s
  return {
    dot,
    dotPositions,
    innerPlotArea: { x: margins.left, y: margins.top, width: plotW, height: plotH },
    dotRadius: dotRadiusFor(format),
    labelSize,
    labelWidth: computeLabelWidth(score.toFixed(1), labelSize),
  }
}

describe('computeScoreLabelPosition (curve-aware)', () => {
  // Synthetic dead-flat polyline at y=500 so clearance calculations are
  // predictable. Dot placed in the middle of a 1000×1000 area.
  const flatDots = Array.from({ length: 9 }, (_, i) => ({ x: i * 125, y: 500 }))
  const INNER = { x: 0, y: 0, width: 1000, height: 1000 }

  it('dot in clear space: picks a position that does not cross the line', () => {
    const pos = computeScoreLabelPosition({
      dot: { x: 500, y: 200 }, // dot well above the flat line
      dotPositions: flatDots,
      innerPlotArea: INNER,
      dotRadius: 5,
      labelSize: 36,
      labelWidth: computeLabelWidth('8.7', 36),
    })
    // Label bbox should not include y=500.
    expect(pos.bbox.yMax).toBeLessThan(500)
    expect(pos.clearance).toBeGreaterThan(0)
  })

  it('dot in clear space: prefers the default offset (closest to dot)', () => {
    const pos = computeScoreLabelPosition({
      dot: { x: 500, y: 200 },
      dotPositions: flatDots,
      innerPlotArea: INNER,
      dotRadius: 5,
      labelSize: 36,
      labelWidth: computeLabelWidth('8.7', 36),
    })
    expect(pos.offsetDistance).toBe(12)
  })

  it('dot sitting ON the line forces the picker to move the label off the line', () => {
    // Dot at y=500 with a flat line at y=500 → both horizontal (0°/180°)
    // candidates have the line passing through the bbox. The picker must
    // pick a top or bottom candidate.
    const pos = computeScoreLabelPosition({
      dot: { x: 500, y: 500 },
      dotPositions: flatDots,
      innerPlotArea: INNER,
      dotRadius: 5,
      labelSize: 36,
      labelWidth: computeLabelWidth('8.7', 36),
    })
    // Must be a top (>90°? wait) or bottom candidate — not 0 or 180.
    const verticalAngles = [45, 90, 135, 225, 270, 315]
    expect(verticalAngles).toContain(pos.candidateAngleDeg)
  })

  it('dot near top edge: picks a position that keeps the bbox in-bounds', () => {
    const pos = computeScoreLabelPosition({
      dot: { x: 500, y: 20 },
      dotPositions: flatDots,
      innerPlotArea: INNER,
      dotRadius: 5,
      labelSize: 36,
      labelWidth: computeLabelWidth('8.7', 36),
    })
    expect(pos.bbox.yMin).toBeGreaterThanOrEqual(INNER.y)
    expect(pos.bbox.yMax).toBeLessThanOrEqual(INNER.y + INNER.height)
    expect(pos.bbox.xMin).toBeGreaterThanOrEqual(INNER.x)
    expect(pos.bbox.xMax).toBeLessThanOrEqual(INNER.x + INNER.width)
  })

  it('dot near a plot corner: picks in-bounds position', () => {
    const w = computeLabelWidth('8.7', 36)
    const pos = computeScoreLabelPosition({
      dot: { x: w + 10, y: 30 }, // forces label away from top-left
      dotPositions: flatDots,
      innerPlotArea: INNER,
      dotRadius: 5,
      labelSize: 36,
      labelWidth: w,
    })
    expect(pos.bbox.yMin).toBeGreaterThanOrEqual(INNER.y)
    expect(pos.bbox.xMin).toBeGreaterThanOrEqual(INNER.x)
  })

  it('picker output depends on the polyline shape, not just the dot', () => {
    // Same dot, two different line shapes. The picker should pick
    // different candidates.
    const dot = { x: 500, y: 500 }
    const horizontalDots = Array.from({ length: 9 }, (_, i) => ({ x: i * 125, y: 490 }))
    const aboveDots = Array.from({ length: 9 }, (_, i) => ({ x: i * 125, y: 100 }))
    const a = computeScoreLabelPosition({
      dot,
      dotPositions: horizontalDots,
      innerPlotArea: INNER,
      dotRadius: 5,
      labelSize: 36,
      labelWidth: computeLabelWidth('8.7', 36),
    })
    const b = computeScoreLabelPosition({
      dot,
      dotPositions: aboveDots,
      innerPlotArea: INNER,
      dotRadius: 5,
      labelSize: 36,
      labelWidth: computeLabelWidth('8.7', 36),
    })
    // At least one of {angle, clearance} differs between the two runs.
    expect(
      a.candidateAngleDeg !== b.candidateAngleDeg ||
        Math.abs(a.clearance - b.clearance) > 0.5,
    ).toBe(true)
  })

  it('returns best-available and does not exceed 60px when every candidate collides', () => {
    // Dense set of dots all at the dot's Y so every candidate bbox has
    // the line passing through its X range at the dot's height. The
    // picker can still get clearance by going vertical.
    const denseDots = Array.from({ length: 20 }, (_, i) => ({ x: i * 50, y: 500 }))
    const pos = computeScoreLabelPosition({
      dot: { x: 500, y: 500 },
      dotPositions: denseDots,
      innerPlotArea: INNER,
      dotRadius: 5,
      labelSize: 36,
      labelWidth: computeLabelWidth('8.7', 36),
    })
    expect(pos.offsetDistance).toBeLessThanOrEqual(60)
  })

  it('never exceeds 60 px offset even with a fully colliding polyline', () => {
    // Construct a "wall" of dots that cover every candidate's X range
    // at the dot's Y. The picker should still return at <= 60 px.
    const wallDots = Array.from({ length: 50 }, (_, i) => ({ x: i * 20, y: 500 }))
    const pos = computeScoreLabelPosition({
      dot: { x: 500, y: 500 },
      dotPositions: wallDots,
      innerPlotArea: INNER,
      dotRadius: 5,
      labelSize: 36,
      labelWidth: computeLabelWidth('8.7', 36),
    })
    expect(pos.offsetDistance).toBeLessThanOrEqual(60)
  })

  it('returns all required diagnostic fields', () => {
    const pos = computeScoreLabelPosition({
      dot: { x: 500, y: 200 },
      dotPositions: flatDots,
      innerPlotArea: INNER,
      dotRadius: 5,
      labelSize: 36,
      labelWidth: computeLabelWidth('8.7', 36),
    })
    expect(pos).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      anchor: expect.stringMatching(/^(start|middle|end)$/),
      clearance: expect.any(Number),
      candidateAngleDeg: expect.any(Number),
      offsetDistance: expect.any(Number),
      bbox: {
        xMin: expect.any(Number),
        xMax: expect.any(Number),
        yMin: expect.any(Number),
        yMax: expect.any(Number),
      },
    })
  })
})

describe('computeScoreLabelPosition — achieved clearance across film fixtures', () => {
  // Data trail for tuning. Each test name logs the format/slide and the
  // achieved clearance + chosen angle + offset. PHM beat indices map the
  // same way as verify-slide-composer.ts (slide 2→idx1, slide 4→idx8,
  // etc.). Kill Bill indices map to 1..6 middle-slide roles heuristically.
  const PHM_SLIDES: Array<{ slide: 2 | 3 | 4 | 5 | 6 | 7; beatIdx: number }> = [
    { slide: 2, beatIdx: 1 },
    { slide: 3, beatIdx: 6 },
    { slide: 4, beatIdx: 8 },
    { slide: 5, beatIdx: 9 },
    { slide: 6, beatIdx: 12 },
    { slide: 7, beatIdx: 16 },
  ]
  const KILL_BILL_SLIDES: Array<{ slide: 2 | 3 | 4 | 5 | 6 | 7; beatIdx: number }> = [
    { slide: 2, beatIdx: 1 }, // opening peak
    { slide: 3, beatIdx: 3 }, // Vernita Green fight
    { slide: 4, beatIdx: 7 }, // quiet valley
    { slide: 5, beatIdx: 6 }, // Hattori Hanzo
    { slide: 6, beatIdx: 10 }, // climax
    { slide: 7, beatIdx: 11 }, // wind-down
  ]
  const formats = ['4x5', '9x16'] as const

  const cases = [
    ...formats.flatMap((fmt) =>
      PHM_SLIDES.map(({ slide, beatIdx }) => ({
        label: `PHM slide ${slide} · ${fmt}`,
        format: fmt,
        data: PHM_DATA,
        runtime: PHM_FILM.totalRuntimeMinutes,
        beatIdx,
      })),
    ),
    ...formats.flatMap((fmt) =>
      KILL_BILL_SLIDES.map(({ slide, beatIdx }) => ({
        label: `Kill Bill slide ${slide} · ${fmt}`,
        format: fmt,
        data: KILL_BILL_DATA,
        runtime: KILL_BILL_RUNTIME,
        beatIdx,
      })),
    ),
  ]

  it.each(cases)(
    '$label — achieved clearance logged as part of result',
    ({ label, format, data, runtime, beatIdx }) => {
      const labelSize = format === '4x5' ? 28 : 36
      const input = buildPickerInput(data, runtime, format, beatIdx, labelSize)
      const pos = computeScoreLabelPosition(input)
      // eslint-disable-next-line no-console
      console.log(
        `[label-clearance] ${label.padEnd(28)} | clearance=${pos.clearance.toFixed(2).padStart(7)}px | angle=${String(pos.candidateAngleDeg).padStart(3)}° | offset=${String(pos.offsetDistance).padStart(2)}px | anchor=${pos.anchor}`,
      )
      // Sanity assertions — picker must return a valid in-bounds position
      // (or best-available) and label must stay in the inner plot area.
      expect(pos.bbox.xMin).toBeGreaterThanOrEqual(input.innerPlotArea.x - 1)
      expect(pos.bbox.xMax).toBeLessThanOrEqual(
        input.innerPlotArea.x + input.innerPlotArea.width + 1,
      )
      expect(pos.bbox.yMin).toBeGreaterThanOrEqual(input.innerPlotArea.y - 1)
      expect(pos.bbox.yMax).toBeLessThanOrEqual(
        input.innerPlotArea.y + input.innerPlotArea.height + 1,
      )
      expect(pos.offsetDistance).toBeLessThanOrEqual(60)
    },
  )
})
