import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the args passed to the Anthropic SDK so we can drive the mock
// response per-test and assert on the request shape without network.
const mockMessagesCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: (...args: unknown[]) => mockMessagesCreate(...args),
    }
  }
  return { default: MockAnthropic }
})

import {
  BodyCopyGenerationError,
  buildSystemPrompt,
  buildUserPrompt,
  computeCharacteristics,
  generateBodyCopy,
  type GenerateBodyCopyInput,
  type GraphCharacteristics,
  type SlideBeatContext,
} from '@/lib/carousel/body-copy-generator'
import type { DataPoint } from '@/lib/carousel/graph-renderer'

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

const PHM_SLIDES: SlideBeatContext[] = [
  { slideNumber: 2, pillLabel: 'THE OPENING \u00b7 0M-5M', beatTimestamp: 5, beatScore: 7.8, beatColor: 'gold' },
  { slideNumber: 3, pillLabel: 'THE SETUP \u00b7 15M-55M', beatTimestamp: 55, beatScore: 8.1, beatColor: 'teal' },
  { slideNumber: 4, pillLabel: 'THE DROP \u00b7 1H 15M', beatTimestamp: 75, beatScore: 5.8, beatColor: 'red' },
  { slideNumber: 5, pillLabel: 'FIRST CONTACT \u00b7 1H 25M', beatTimestamp: 85, beatScore: 8.7, beatColor: 'teal' },
  { slideNumber: 6, pillLabel: 'THE PEAK \u00b7 1H 55M', beatTimestamp: 115, beatScore: 9.5, beatColor: 'teal' },
  { slideNumber: 7, pillLabel: 'THE ENDING \u00b7 2H 34M', beatTimestamp: 154, beatScore: 7.4, beatColor: 'gold' },
]

const PHM_INPUT: GenerateBodyCopyInput = {
  filmTitle: 'Project Hail Mary',
  filmYear: 2026,
  runtimeMinutes: 157,
  criticsScore: 8.3,
  dataPoints: PHM_DATA,
  slides: PHM_SLIDES,
}

describe('computeCharacteristics', () => {
  it('PHM data → moderate drop, sharp recovery, late peak 9.5, 1 red dot, down ending', () => {
    const c = computeCharacteristics(PHM_DATA)
    expect(c.dropSeverity).toBe('moderate')
    expect(c.recoveryShape).toBe('sharp')
    expect(c.peakHeight).toBe(9.5)
    expect(c.peakIsLate).toBe(true)
    expect(c.redDotCount).toBe(1)
    expect(c.endingDirection).toBe('down')
  })

  it('flat-arc film (7.0-7.5) → mild drop, no recovery, peak ≤ 7.5, 0 red dots', () => {
    const flat: DataPoint[] = [
      { t: 5, s: 7.1 },
      { t: 15, s: 7.3 },
      { t: 25, s: 7.5 },
      { t: 35, s: 7.2 },
      { t: 45, s: 7.0 },
      { t: 55, s: 7.4 },
      { t: 65, s: 7.2 },
      { t: 75, s: 7.3 },
      { t: 85, s: 7.1 },
      { t: 95, s: 7.4 },
    ]
    const c = computeCharacteristics(flat)
    expect(c.dropSeverity).toBe('mild')
    expect(c.recoveryShape).toBe('none')
    expect(c.peakHeight).toBeLessThanOrEqual(7.5)
    expect(c.redDotCount).toBe(0)
  })

  it('dramatic drop when lowest < 4.0', () => {
    const data: DataPoint[] = [
      { t: 5, s: 7.0 },
      { t: 15, s: 6.5 },
      { t: 25, s: 3.2 },
      { t: 35, s: 5.5 },
    ]
    const c = computeCharacteristics(data)
    expect(c.dropSeverity).toBe('dramatic')
  })

  it('endingDirection up when final beat rises > 0.5 over the last 15%', () => {
    const data: DataPoint[] = [
      { t: 10, s: 7.0 },
      { t: 30, s: 7.2 },
      { t: 60, s: 7.1 },
      { t: 90, s: 8.0 },
      { t: 100, s: 9.2 },
    ]
    const c = computeCharacteristics(data)
    expect(c.endingDirection).toBe('up')
  })

  it('throws on empty dataPoints', () => {
    expect(() => computeCharacteristics([])).toThrow()
  })
})

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt()

  it('contains the sentence-case rule', () => {
    expect(prompt).toContain('Sentence case')
  })

  it('forbids em dashes explicitly', () => {
    expect(prompt).toContain('No em dashes')
  })

  it('requires concrete numbers', () => {
    expect(prompt).toMatch(/concrete numbers/i)
  })

  it('specifies the JSON output shape with all 6 slide keys', () => {
    for (let n = 2; n <= 7; n++) {
      expect(prompt).toContain(`"slide_${n}"`)
    }
  })

  it('includes the reference voice examples', () => {
    expect(prompt).toContain("Ryland wakes up on a spaceship")
    expect(prompt).toContain('2.9 point jump')
  })
})

describe('buildUserPrompt', () => {
  it('serializes film metadata, data points, characteristics, and all 6 slide contexts as JSON', () => {
    const chars: GraphCharacteristics = computeCharacteristics(PHM_DATA)
    const user = buildUserPrompt(PHM_INPUT, chars)

    expect(user).toContain('Project Hail Mary')
    expect(user).toContain('2026')
    expect(user).toContain('"runtimeMinutes": 157')
    expect(user).toContain('"criticsScore": 8.3')

    // Data points — a couple of representative rows.
    expect(user).toContain('"t": 75')
    expect(user).toContain('"s": 5.8')
    expect(user).toContain('"t": 115')
    expect(user).toContain('"s": 9.5')

    // Characteristics.
    expect(user).toContain('"dropSeverity": "moderate"')
    expect(user).toContain('"recoveryShape": "sharp"')
    expect(user).toContain('"peakIsLate": true')

    // All six slide contexts present.
    for (const s of PHM_SLIDES) {
      expect(user).toContain(`"slideNumber": ${s.slideNumber}`)
      expect(user).toContain(s.pillLabel)
    }
  })
})

// ── generateBodyCopy with a mocked API client ─────────────────

function mockApiResponse(bodyCopyBySlide: Record<string, string>) {
  return {
    content: [{ type: 'text', text: JSON.stringify(bodyCopyBySlide) }],
    usage: {
      input_tokens: 1500,
      output_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

function validBodyCopyMap(): Record<string, string> {
  return {
    slide_2: 'The score hits 7.8 almost immediately. Audiences are locked in before minute 5.',
    slide_3: 'A slow build through the first hour. The score hovers around 8.1.',
    slide_4: 'At 1h 15m the score bottoms out at 5.8. The only red dot in the film.',
    slide_5: 'A 2.9 point jump in ten minutes. The score climbs to 8.7.',
    slide_6: 'The score hits 9.5. You do not get this high without the 5.8 that came before it.',
    slide_7: 'The ending drops to 7.4. A deliberate, bittersweet landing.',
  }
}

describe('generateBodyCopy (mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns bodyCopy for all 6 slides with characteristics, model, and token usage', async () => {
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(validBodyCopyMap()))

    const out = await generateBodyCopy(PHM_INPUT)
    expect(Object.keys(out.bodyCopy)).toEqual(['2', '3', '4', '5', '6', '7'])
    expect(out.bodyCopy[4]).toContain('5.8')
    expect(out.characteristics.peakHeight).toBe(9.5)
    expect(out.modelUsed).toMatch(/sonnet/i)
    expect(out.totalTokens).toBe(1800)
  })

  it('throws BodyCopyGenerationError when copy contains an em dash', async () => {
    const map = validBodyCopyMap()
    map.slide_5 = 'A 2.9 point jump \u2014 the biggest in the film \u2014 lifts the score to 8.7.'
    mockMessagesCreate.mockResolvedValue(mockApiResponse(map))

    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(BodyCopyGenerationError)
    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(
      /forbidden dash character/,
    )
    try {
      await generateBodyCopy(PHM_INPUT)
      throw new Error('expected throw')
    } catch (err) {
      const e = err as BodyCopyGenerationError
      expect(e).toBeInstanceOf(BodyCopyGenerationError)
      expect(e.offendingSlide).toBe(5)
      expect(e.rawResponse).toContain('\u2014')
    }
  })

  it('throws BodyCopyGenerationError when copy contains an en dash', async () => {
    const map = validBodyCopyMap()
    map.slide_6 = 'The score jumps 5.8 \u2013 9.5 across twenty minutes.'
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(map))

    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(BodyCopyGenerationError)
  })

  it('throws BodyCopyGenerationError when a slide key is missing', async () => {
    const map = validBodyCopyMap()
    delete map.slide_6
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(map))

    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(/slide_6/)
  })

  it('throws BodyCopyGenerationError on malformed JSON', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not json at all' }],
      usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(/JSON/)
  })

  it('sends a request with cache_control on system and includes all 6 slide contexts in user', async () => {
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(validBodyCopyMap()))
    await generateBodyCopy(PHM_INPUT)

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1)
    const args = mockMessagesCreate.mock.calls[0][0] as {
      model: string
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>
      messages: Array<{ role: string; content: string }>
    }
    expect(args.model).toMatch(/sonnet/i)
    expect(args.system[0].cache_control?.type).toBe('ephemeral')
    const userContent = args.messages[0].content
    for (const s of PHM_SLIDES) {
      expect(userContent).toContain(s.pillLabel)
    }
  })

  it('throws when slides arg does not have exactly the slide numbers 2..7 in order', async () => {
    const bad: GenerateBodyCopyInput = {
      ...PHM_INPUT,
      slides: PHM_SLIDES.slice(0, 5),
    }
    await expect(generateBodyCopy(bad)).rejects.toThrow(/exactly 6/)

    const reordered: GenerateBodyCopyInput = {
      ...PHM_INPUT,
      slides: [...PHM_SLIDES].reverse() as SlideBeatContext[],
    }
    await expect(generateBodyCopy(reordered)).rejects.toThrow(/slideNumber/)
  })
})
