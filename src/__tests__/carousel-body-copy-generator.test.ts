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
  parseBodyCopyResponse,
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
  { slideNumber: 2, pillLabel: 'THE OPENING', beatTimestamp: 5, beatScore: 7.8, beatColor: 'gold', originalRole: 'opening', storyBeatName: 'Ryland wakes up alone on the Hail Mary' },
  { slideNumber: 3, pillLabel: 'THE SETUP', beatTimestamp: 55, beatScore: 8.1, beatColor: 'teal', originalRole: 'setup', storyBeatName: 'Eva Stratt reveals the suicide mission to Tau Ceti' },
  { slideNumber: 4, pillLabel: 'THE DROP', beatTimestamp: 75, beatScore: 5.8, beatColor: 'red', originalRole: 'drop', storyBeatName: 'Grace is drugged and forcibly loaded onto Hail Mary' },
  { slideNumber: 5, pillLabel: 'RECOVERY', beatTimestamp: 85, beatScore: 8.7, beatColor: 'teal', originalRole: 'recovery', storyBeatName: "Rocky's spacecraft appears at Tau Ceti" },
  { slideNumber: 6, pillLabel: 'THE PEAK', beatTimestamp: 115, beatScore: 9.5, beatColor: 'teal', originalRole: 'peak', storyBeatName: 'Rocky breaks his spacesuit to save unconscious Grace' },
  { slideNumber: 7, pillLabel: 'THE ENDING', beatTimestamp: 154, beatScore: 7.4, beatColor: 'gold', originalRole: 'ending', storyBeatName: 'Grace teaches alien children on Erid' },
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

  it('specifies the JSON shape includes pill, headline, and body fields', () => {
    expect(prompt).toContain('"pill"')
    expect(prompt).toContain('"headline"')
    expect(prompt).toContain('"body"')
  })

  it('includes the reference voice examples', () => {
    expect(prompt).toContain('Ryland')
    expect(prompt).toContain('5.8')
  })

  it('contains HEADLINE GUIDANCE with length + forbidden-phrase rules', () => {
    expect(prompt).toMatch(/headline/i)
    expect(prompt).toMatch(/3 to 6 words/i)
    // A sampling of the forbidden generic filler phrases must be listed
    // verbatim so the model learns to avoid them.
    expect(prompt).toContain('Where the story starts')
    expect(prompt).toContain('How it lands')
    expect(prompt).toContain('Then the floor drops out')
    expect(prompt).toContain('Then it finds its footing')
    expect(prompt).toContain('The audience settles in')
    expect(prompt).toContain('Another beat in the shape')
    expect(prompt).toContain("The film's highest moment")
  })

  it('instructs the model to trust data over slot role when they disagree', () => {
    // Used to keep the model honest when the slot label (drop/peak) no
    // longer matches the actual score behaviour after the spacing swap.
    expect(prompt).toMatch(/trust the data/i)
  })

  it('specifies the FORMAT MARKERS rule with {{color:value}} syntax and all three color thresholds', () => {
    expect(prompt).toMatch(/format markers/i)
    expect(prompt).toContain('{{red:')
    expect(prompt).toContain('{{gold:')
    expect(prompt).toContain('{{teal:')
    // Thresholds must be present so the LLM knows which color to pick.
    expect(prompt).toMatch(/below 6\.0/)
    expect(prompt).toMatch(/8\.0/)
  })

  it('specifies the TIME FORMAT rule requiring numerals for time references', () => {
    expect(prompt).toMatch(/time format/i)
    expect(prompt).toMatch(/numeral/i)
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

    // All six slide contexts present — originalRole + storyBeatName replace
    // the legacy pillLabel in the serialized user prompt.
    for (const s of PHM_SLIDES) {
      expect(user).toContain(`"slideNumber": ${s.slideNumber}`)
      expect(user).toContain(`"originalRole": "${s.originalRole}"`)
      expect(user).toContain(s.storyBeatName)
    }
  })

  it('includes scoreDelta on each slide (0 for the first, delta to previous for the rest)', () => {
    const chars: GraphCharacteristics = computeCharacteristics(PHM_DATA)
    const user = buildUserPrompt(PHM_INPUT, chars)

    // The serializer must emit scoreDelta on every slide context.
    expect(user).toContain('"scoreDelta"')

    // slide_2 is first → scoreDelta = 0.
    // slide_3 score 8.1 - slide_2 score 7.8 = 0.3.
    // slide_4 score 5.8 - slide_3 score 8.1 = -2.3.
    // slide_5 score 8.7 - slide_4 score 5.8 = 2.9.
    // slide_6 score 9.5 - slide_5 score 8.7 = 0.8.
    // slide_7 score 7.4 - slide_6 score 9.5 = -2.1.
    // Match a few representative deltas. Exact decimal formatting depends
    // on JSON.stringify, so look for the numeric substring.
    expect(user).toMatch(/"scoreDelta":\s*0[,\n]/) // first slide
    expect(user).toMatch(/"scoreDelta":\s*-2\.3/) // slide 4
    expect(user).toMatch(/"scoreDelta":\s*2\.9/) // slide 5
  })
})

// ── generateBodyCopy with a mocked API client ─────────────────

function mockApiResponse(
  slideCopyBySlide: Record<string, { pill: string; headline: string; body: string }>,
) {
  return {
    content: [{ type: 'text', text: JSON.stringify(slideCopyBySlide) }],
    usage: {
      input_tokens: 1500,
      output_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

function validSlideCopyMap(): Record<
  string,
  { pill: string; headline: string; body: string }
> {
  return {
    slide_2: {
      pill: 'Ryland wakes alone',
      headline: 'Already inside the mystery.',
      body: 'The score hits 7.8 almost immediately. Audiences are locked in before minute 5.',
    },
    slide_3: {
      pill: 'Stratt reveals the mission',
      headline: 'Stakes become clear.',
      body: 'A slow build through the first hour. The score hovers around 8.1.',
    },
    slide_4: {
      pill: 'Grace forced onto ship',
      headline: 'No consent, no way back.',
      body: 'At 1h 15m the score bottoms out at 5.8. The only red dot in the film.',
    },
    slide_5: {
      pill: 'Rocky at Tau Ceti',
      headline: 'Hope arrives with company.',
      body: 'A 2.9 point jump in ten minutes. The score climbs to 8.7.',
    },
    slide_6: {
      pill: 'Rocky saves Grace',
      headline: 'Sacrifice without hesitation.',
      body: 'The score hits 9.5. You do not get this high without the 5.8 that came before it.',
    },
    slide_7: {
      pill: 'Grace teaches children',
      headline: 'A quieter resolution.',
      body: 'The ending drops to 7.4. A deliberate, bittersweet landing.',
    },
  }
}

describe('generateBodyCopy (mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns slideCopy for all 6 slides with pill + headline + body, characteristics, model, and token usage', async () => {
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(validSlideCopyMap()))

    const out = await generateBodyCopy(PHM_INPUT)
    expect(Object.keys(out.slideCopy)).toEqual(['2', '3', '4', '5', '6', '7'])
    expect(out.slideCopy[4].body).toContain('5.8')
    expect(out.slideCopy[4].pill).toBe('Grace forced onto ship')
    expect(out.slideCopy[4].headline).toBe('No consent, no way back.')
    expect(out.slideCopy[6].pill).toBe('Rocky saves Grace')
    expect(out.slideCopy[6].headline).toBe('Sacrifice without hesitation.')
    expect(out.characteristics.peakHeight).toBe(9.5)
    expect(out.modelUsed).toMatch(/sonnet/i)
    expect(out.totalTokens).toBe(1800)
  })

  it('throws BodyCopyGenerationError when body contains an em dash', async () => {
    const map = validSlideCopyMap()
    map.slide_5.body = 'A 2.9 point jump \u2014 the biggest in the film \u2014 lifts the score to 8.7.'
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

  it('throws BodyCopyGenerationError when body contains an en dash', async () => {
    const map = validSlideCopyMap()
    map.slide_6.body = 'The score jumps 5.8 \u2013 9.5 across twenty minutes.'
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(map))

    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(BodyCopyGenerationError)
  })

  it('throws BodyCopyGenerationError when a pill contains an em dash', async () => {
    const map = validSlideCopyMap()
    map.slide_3.pill = 'Stratt \u2014 the mission'
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(map))

    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(
      /pill contains forbidden dash/,
    )
  })

  it('throws BodyCopyGenerationError when a pill exceeds 36 characters', async () => {
    const map = validSlideCopyMap()
    map.slide_2.pill = 'This pill is absolutely longer than the new thirty-six character limit'
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(map))

    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(/exceeds 36 characters/)
  })

  it('throws BodyCopyGenerationError when a slide key is missing', async () => {
    const map = validSlideCopyMap()
    delete map.slide_6
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(map))

    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(/slide_6/)
  })

  it('throws BodyCopyGenerationError when a slide key is missing pill or body', async () => {
    const map = validSlideCopyMap() as Record<string, unknown>
    map.slide_4 = { body: 'only body, no pill', headline: 'headline ok' }
    mockMessagesCreate.mockResolvedValueOnce(
      mockApiResponse(
        map as Record<string, { pill: string; headline: string; body: string }>,
      ),
    )
    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(/pill/)
  })

  it('throws BodyCopyGenerationError when a slide key is missing headline', async () => {
    const map = validSlideCopyMap() as Record<string, unknown>
    map.slide_5 = {
      pill: 'Rocky at Tau Ceti',
      body: 'A 2.9 point jump in ten minutes. The score climbs to 8.7.',
    }
    mockMessagesCreate.mockResolvedValueOnce(
      mockApiResponse(
        map as Record<string, { pill: string; headline: string; body: string }>,
      ),
    )
    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(/headline/)
  })

  it('throws BodyCopyGenerationError when a headline is an empty string', async () => {
    const map = validSlideCopyMap()
    map.slide_3.headline = '   '
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(map))
    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(/headline/)
  })

  it('throws BodyCopyGenerationError when a headline contains an em dash', async () => {
    const map = validSlideCopyMap()
    map.slide_6.headline = 'Sacrifice \u2014 without hesitation.'
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(map))
    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(
      /headline contains forbidden dash/,
    )
  })

  it('throws BodyCopyGenerationError on malformed JSON', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not json at all' }],
      usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
    await expect(generateBodyCopy(PHM_INPUT)).rejects.toThrow(/JSON/)
  })

  it('sends a request with cache_control on system and includes originalRole + storyBeatName in user', async () => {
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(validSlideCopyMap()))
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
      expect(userContent).toContain(`"originalRole": "${s.originalRole}"`)
      expect(userContent).toContain(s.storyBeatName)
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

describe('parseBodyCopyResponse — forgiving JSON extraction', () => {
  it('parses raw JSON directly', () => {
    const raw = JSON.stringify(validSlideCopyMap())
    const parsed = parseBodyCopyResponse(raw)
    expect(parsed[2].body).toContain('7.8')
    expect(parsed[4].body).toContain('5.8')
    expect(parsed[6].body).toContain('9.5')
    expect(parsed[6].pill).toBe('Rocky saves Grace')
    expect(parsed[6].headline).toBe('Sacrifice without hesitation.')
    // Every middle slide must carry all three string fields.
    for (const n of [2, 3, 4, 5, 6, 7] as const) {
      expect(typeof parsed[n].pill).toBe('string')
      expect(typeof parsed[n].headline).toBe('string')
      expect(typeof parsed[n].body).toBe('string')
    }
  })

  it('parses JSON preceded by a preamble sentence', () => {
    const json = JSON.stringify(validSlideCopyMap())
    const raw = `Here is the body copy:\n\n${json}`
    const parsed = parseBodyCopyResponse(raw)
    expect(parsed[4].body).toContain('5.8')
    expect(parsed[6].body).toContain('9.5')
  })

  it('parses JSON wrapped in a ```json code fence', () => {
    const json = JSON.stringify(validSlideCopyMap())
    const raw = '```json\n' + json + '\n```'
    const parsed = parseBodyCopyResponse(raw)
    expect(parsed[6].body).toContain('9.5')
  })

  it('parses JSON wrapped in a plain ``` code fence (no language tag)', () => {
    const json = JSON.stringify(validSlideCopyMap())
    const raw = '```\n' + json + '\n```'
    const parsed = parseBodyCopyResponse(raw)
    expect(parsed[2].body).toContain('7.8')
  })

  it('throws BodyCopyGenerationError with rawResponse attached when every attempt fails', () => {
    const raw = 'absolute garbage with no valid json structure whatsoever'
    let caught: unknown
    try {
      parseBodyCopyResponse(raw)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BodyCopyGenerationError)
    const e = caught as BodyCopyGenerationError
    expect(e.rawResponse).toBe(raw)
    expect(e.message).toContain(raw)
  })
})
