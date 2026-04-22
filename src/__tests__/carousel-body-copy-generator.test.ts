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
  generateBodyCopyForSlide,
  parseBodyCopyResponse,
  parseSingleSlideResponse,
  type GenerateBodyCopyForSlideInput,
  type GenerateBodyCopyInput,
  type GraphCharacteristics,
  type PreviousSlideContext,
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

  it('truncates a pill exceeding 36 chars at the nearest word boundary with ellipsis', async () => {
    // 40-char pill, last space at position 28 (after "train"); truncation
    // should cut there and append "...", giving a 31-char result.
    const map = validSlideCopyMap()
    map.slide_3.pill = 'Juror 8 challenges the train noise claim'
    expect(map.slide_3.pill.length).toBe(40)
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(map))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = await generateBodyCopy(PHM_INPUT)
      expect(out.slideCopy[3].pill).toBe('Juror 8 challenges the train...')
      expect(out.slideCopy[3].pill.length).toBeLessThanOrEqual(36)
      expect(out.slideCopy[3].pill.endsWith('...')).toBe(true)
      expect(warnSpy).toHaveBeenCalled()
      const warnMsg = warnSpy.mock.calls[0][0] as string
      expect(warnMsg).toContain('slide_3')
      expect(warnMsg).toContain('40')
      expect(warnMsg).toContain('Juror 8 challenges the train noise claim')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('truncates a single long word at 33 chars with ellipsis when no space is in range', async () => {
    // 40-char single word with no internal spaces — the word-boundary search
    // finds nothing inside positions 0..33, so the truncator hard-cuts at 33
    // and appends "...", producing a 36-char result.
    const map = validSlideCopyMap()
    map.slide_5.pill = 'Antidisestablishmentarianismischallenged'
    expect(map.slide_5.pill.length).toBe(40)
    mockMessagesCreate.mockResolvedValueOnce(mockApiResponse(map))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = await generateBodyCopy(PHM_INPUT)
      expect(out.slideCopy[5].pill).toBe('Antidisestablishmentarianismischa...')
      expect(out.slideCopy[5].pill.length).toBe(36)
      expect(out.slideCopy[5].pill.endsWith('...')).toBe(true)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
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

// ── Single-slide regenerate flow ──────────────────────────────

describe("buildSystemPrompt('single')", () => {
  const full = buildSystemPrompt('full')
  const single = buildSystemPrompt('single')

  it("matches buildSystemPrompt() (default) byte-for-byte when called with 'full'", () => {
    expect(full).toBe(buildSystemPrompt())
  })

  it('mentions that only one slide is being regenerated and others are reference-only', () => {
    expect(single).toContain('ONE slide')
    expect(single).toContain('previous_slides_context')
    expect(single).toMatch(/voice.?\/.?pattern reference only/i)
    expect(single).toMatch(/do NOT regenerate or output anything/i)
  })

  it("emits a single-object output schema (no slide_N keys) when mode is 'single'", () => {
    expect(single).not.toContain('"slide_2"')
    expect(single).not.toContain('"slide_7"')
    expect(single).toContain('{ "pill": "..."')
    expect(single).toContain('Do not wrap in a "slide_N" key')
  })

  it('drops the 6-slide coordination rules in single mode', () => {
    // Full mode hard-codes these; single mode must remove them since the
    // model is only producing ONE slide.
    expect(full).toContain('Vary sentence structures across the six slides')
    expect(single).not.toContain('Vary sentence structures across the six slides')
    expect(full).toContain('For slides 4, 5, 6 in particular')
    expect(single).not.toContain('For slides 4, 5, 6 in particular')
    expect(full).toContain('Mix and match across the six slides')
    expect(single).not.toContain('Mix and match across the six slides')
  })

  it('keeps the per-slide rules (voice, pill, headline, color markers, time format)', () => {
    // Every per-slide rule still applies in single mode.
    expect(single).toContain('Sentence case always')
    expect(single).toContain('No em dashes')
    expect(single).toMatch(/format markers/i)
    expect(single).toContain('{{red:')
    expect(single).toContain('{{gold:')
    expect(single).toContain('{{teal:')
    expect(single).toMatch(/time format/i)
    expect(single).toMatch(/3 to 6 words/i)
    expect(single).toContain('Where the story starts')
  })
})

const PHM_PREVIOUS_SLIDES: PreviousSlideContext[] = [
  {
    slideNumber: 2,
    beatTimestamp: 5,
    beatScore: 7.8,
    beatColor: 'gold',
    originalRole: 'opening',
    storyBeatName: 'Ryland wakes up alone on the Hail Mary',
    copy: {
      pill: 'Ryland wakes alone',
      headline: 'Already inside the mystery.',
      body: 'The score hits {{gold:7.8}} almost immediately. Audiences are locked in before minute 5.',
    },
  },
  {
    slideNumber: 3,
    beatTimestamp: 55,
    beatScore: 8.1,
    beatColor: 'teal',
    originalRole: 'setup',
    storyBeatName: 'Eva Stratt reveals the suicide mission to Tau Ceti',
    copy: {
      pill: 'Stratt reveals the mission',
      headline: 'Stakes become clear.',
      body: 'A slow build through the first hour. The score hovers around {{teal:8.1}}.',
    },
  },
  {
    slideNumber: 5,
    beatTimestamp: 85,
    beatScore: 8.7,
    beatColor: 'teal',
    originalRole: 'recovery',
    storyBeatName: "Rocky's spacecraft appears at Tau Ceti",
    copy: {
      pill: 'Rocky at Tau Ceti',
      headline: 'Hope arrives with company.',
      body: 'A 2.9 point jump in ten minutes. The score climbs to {{teal:8.7}}.',
    },
  },
  {
    slideNumber: 6,
    beatTimestamp: 115,
    beatScore: 9.5,
    beatColor: 'teal',
    originalRole: 'peak',
    storyBeatName: 'Rocky breaks his spacesuit to save unconscious Grace',
    copy: {
      pill: 'Rocky saves Grace',
      headline: 'Sacrifice without hesitation.',
      body: 'The score hits {{teal:9.5}}. You do not get this high without the {{red:5.8}} that came before it.',
    },
  },
  {
    slideNumber: 7,
    beatTimestamp: 154,
    beatScore: 7.4,
    beatColor: 'gold',
    originalRole: 'ending',
    storyBeatName: 'Grace teaches alien children on Erid',
    copy: {
      pill: 'Grace teaches children',
      headline: 'A quieter resolution.',
      body: 'The ending drops to {{gold:7.4}}. A deliberate, bittersweet landing.',
    },
  },
]

// Regenerating slide 4 — the drop. Mirrors the PHM fixture's slide 4 beat.
const PHM_TARGET_SLIDE: SlideBeatContext = {
  slideNumber: 4,
  pillLabel: 'Grace forced onto ship',
  beatTimestamp: 75,
  beatScore: 5.8,
  beatColor: 'red',
  originalRole: 'drop',
  storyBeatName: 'Grace is drugged and forcibly loaded onto Hail Mary',
}

const PHM_REGEN_INPUT: GenerateBodyCopyForSlideInput = {
  filmTitle: 'Project Hail Mary',
  filmYear: 2026,
  runtimeMinutes: 157,
  criticsScore: 8.3,
  dataPoints: PHM_DATA,
  slide: PHM_TARGET_SLIDE,
  previousSlides: PHM_PREVIOUS_SLIDES,
}

describe('buildUserPrompt (single-slide dispatch)', () => {
  const chars: GraphCharacteristics = computeCharacteristics(PHM_DATA)
  const user = buildUserPrompt(PHM_REGEN_INPUT, chars)

  it('serializes film metadata, data points, and characteristics', () => {
    expect(user).toContain('Project Hail Mary')
    expect(user).toContain('"runtimeMinutes": 157')
    expect(user).toContain('"dropSeverity": "moderate"')
  })

  it('includes the target slide under a distinct "Slide to regenerate" header', () => {
    expect(user).toContain('Slide to regenerate')
    expect(user).toContain('"slideNumber": 4')
    expect(user).toContain('"originalRole": "drop"')
    expect(user).toContain(PHM_TARGET_SLIDE.storyBeatName)
  })

  it('computes scoreDelta against the immediately preceding slide by slideNumber', () => {
    // Slide 4 (5.8) - slide 3 (8.1) = -2.3
    expect(user).toMatch(/"scoreDelta":\s*-2\.3/)
  })

  it('includes each previous slide with its full existing copy as READ-ONLY context', () => {
    expect(user).toContain('Previous slides context')
    expect(user).toContain('READ-ONLY')
    for (const p of PHM_PREVIOUS_SLIDES) {
      expect(user).toContain(p.copy.pill)
      expect(user).toContain(p.copy.headline)
      expect(user).toContain(p.storyBeatName)
    }
  })

  it('does NOT include the target slide inside previous_slides_context', () => {
    // The target slide's storyBeatName should appear exactly once (under the
    // "Slide to regenerate" block), not duplicated into the reference section.
    const matches = user.match(
      new RegExp(PHM_TARGET_SLIDE.storyBeatName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    )
    expect(matches?.length ?? 0).toBe(1)
  })

  it('instructs the model to output ONLY the single slide', () => {
    expect(user).toMatch(/output ONLY the requested slide/i)
    expect(user).toMatch(/do NOT output entries for the previous_slides_context/i)
  })
})

function mockSingleSlideResponse(copy: { pill: string; headline: string; body: string }) {
  return {
    content: [{ type: 'text', text: JSON.stringify(copy) }],
    usage: {
      input_tokens: 800,
      output_tokens: 150,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

describe('generateBodyCopyForSlide (mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a single SlideCopy with characteristics, model, and token usage', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      mockSingleSlideResponse({
        pill: 'Grace forced onto ship',
        headline: 'No consent, no way back.',
        body: 'At 1h 15m the score bottoms out at {{red:5.8}}. The only red dot in the film.',
      }),
    )

    const out = await generateBodyCopyForSlide(PHM_REGEN_INPUT)
    expect(out.slideCopy.pill).toBe('Grace forced onto ship')
    expect(out.slideCopy.headline).toBe('No consent, no way back.')
    expect(out.slideCopy.body).toContain('5.8')
    expect(out.characteristics.peakHeight).toBe(9.5)
    expect(out.modelUsed).toMatch(/sonnet/i)
    expect(out.totalTokens).toBe(950)
  })

  it('sends the single-slide variant of the system prompt with cache_control', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      mockSingleSlideResponse({
        pill: 'ok',
        headline: 'ok.',
        body: 'ok body {{red:5.8}}.',
      }),
    )
    await generateBodyCopyForSlide(PHM_REGEN_INPUT)

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1)
    const args = mockMessagesCreate.mock.calls[0][0] as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>
      messages: Array<{ role: string; content: string }>
    }
    expect(args.system[0].cache_control?.type).toBe('ephemeral')
    // Single-slide schema marker — full mode uses "slide_2", "slide_3", etc.
    expect(args.system[0].text).toContain('Do not wrap in a "slide_N" key')
    expect(args.system[0].text).not.toContain('"slide_2"')
  })

  it('tolerates an arbitrary target beat (does NOT require slideNumber 2..7 ordering)', async () => {
    // The full generator rejects out-of-order/too-few slide arrays; the
    // single-slide path should accept any MiddleSlideNumber as the target.
    mockMessagesCreate.mockResolvedValueOnce(
      mockSingleSlideResponse({
        pill: 'Rocky saves Grace',
        headline: 'Sacrifice without hesitation.',
        body: 'The score hits {{teal:9.5}}.',
      }),
    )
    const input: GenerateBodyCopyForSlideInput = {
      ...PHM_REGEN_INPUT,
      slide: { ...PHM_TARGET_SLIDE, slideNumber: 6, beatTimestamp: 115, beatScore: 9.5, beatColor: 'teal' },
    }
    const out = await generateBodyCopyForSlide(input)
    expect(out.slideCopy.pill).toBe('Rocky saves Grace')
  })

  it('throws BodyCopyGenerationError when the returned pill contains an em dash', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      mockSingleSlideResponse({
        pill: 'Stratt \u2014 the mission',
        headline: 'Stakes become clear.',
        body: 'The score hovers around {{teal:8.1}}.',
      }),
    )
    await expect(generateBodyCopyForSlide(PHM_REGEN_INPUT)).rejects.toThrow(
      /pill contains forbidden dash/,
    )
  })

  it('throws BodyCopyGenerationError when the body contains an en dash', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      mockSingleSlideResponse({
        pill: 'Grace forced onto ship',
        headline: 'No consent, no way back.',
        body: 'A jump 5.8 \u2013 8.7 across ten minutes.',
      }),
    )
    await expect(generateBodyCopyForSlide(PHM_REGEN_INPUT)).rejects.toThrow(
      /forbidden dash character/,
    )
  })

  it('throws BodyCopyGenerationError when a required field is missing', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ pill: 'only pill', body: 'only body {{red:5.8}}.' }) }],
      usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
    await expect(generateBodyCopyForSlide(PHM_REGEN_INPUT)).rejects.toThrow(/headline/)
  })

  it('truncates a pill exceeding 36 chars at the nearest word boundary with ellipsis', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      mockSingleSlideResponse({
        pill: 'Juror 8 challenges the train noise claim',
        headline: 'Doubt takes hold.',
        body: 'The score drops to {{red:5.8}}.',
      }),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = await generateBodyCopyForSlide(PHM_REGEN_INPUT)
      expect(out.slideCopy.pill).toBe('Juror 8 challenges the train...')
      expect(out.slideCopy.pill.length).toBeLessThanOrEqual(36)
      const warnMsg = warnSpy.mock.calls[0]?.[0] as string
      expect(warnMsg).toContain('slide_4')
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('parseSingleSlideResponse', () => {
  it('parses a flat { pill, headline, body } object', () => {
    const raw = JSON.stringify({
      pill: 'Grace forced onto ship',
      headline: 'No consent, no way back.',
      body: 'At 1h 15m the score bottoms out at {{red:5.8}}.',
    })
    const parsed = parseSingleSlideResponse(raw, 4)
    expect(parsed.pill).toBe('Grace forced onto ship')
    expect(parsed.headline).toBe('No consent, no way back.')
    expect(parsed.body).toContain('5.8')
  })

  it('tolerates a wrapper like { "slide_4": { ... } }', () => {
    const raw = JSON.stringify({
      slide_4: {
        pill: 'Grace forced onto ship',
        headline: 'No consent, no way back.',
        body: 'At 1h 15m the score bottoms out at {{red:5.8}}.',
      },
    })
    const parsed = parseSingleSlideResponse(raw, 4)
    expect(parsed.pill).toBe('Grace forced onto ship')
  })

  it('parses JSON wrapped in a ```json code fence', () => {
    const inner = {
      pill: 'ok',
      headline: 'ok.',
      body: 'ok body {{red:5.8}}.',
    }
    const raw = '```json\n' + JSON.stringify(inner) + '\n```'
    const parsed = parseSingleSlideResponse(raw, 4)
    expect(parsed.body).toContain('5.8')
  })

  it('throws BodyCopyGenerationError with offendingSlide set when pill is empty', () => {
    const raw = JSON.stringify({ pill: '   ', headline: 'ok.', body: 'ok body {{red:5.8}}.' })
    let caught: unknown
    try {
      parseSingleSlideResponse(raw, 4)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BodyCopyGenerationError)
    expect((caught as BodyCopyGenerationError).offendingSlide).toBe(4)
  })
})
