import Anthropic from '@anthropic-ai/sdk'

import type { DataPoint } from './graph-renderer'

// ── Public types ──────────────────────────────────────────────

export type GraphCharacteristics = {
  dropSeverity: 'dramatic' | 'moderate' | 'mild'
  recoveryShape: 'sharp' | 'gradual' | 'none'
  peakHeight: number
  peakIsLate: boolean
  redDotCount: number
  endingDirection: 'up' | 'down' | 'flat'
}

export type MiddleSlideNumber = 2 | 3 | 4 | 5 | 6 | 7

export type SlideBeatContext = {
  slideNumber: MiddleSlideNumber
  pillLabel: string
  beatTimestamp: number
  beatScore: number
  beatColor: 'red' | 'gold' | 'teal'
}

export type GenerateBodyCopyInput = {
  filmTitle: string
  filmYear: number
  runtimeMinutes: number
  criticsScore: number
  dataPoints: DataPoint[]
  slides: SlideBeatContext[]
}

export type GenerateBodyCopyOutput = {
  bodyCopy: Record<MiddleSlideNumber, string>
  characteristics: GraphCharacteristics
  modelUsed: string
  totalTokens: number
}

export class BodyCopyGenerationError extends Error {
  readonly rawResponse: string | undefined
  readonly offendingSlide: number | undefined

  constructor(
    message: string,
    opts: { rawResponse?: string; offendingSlide?: number } = {},
  ) {
    super(message)
    this.name = 'BodyCopyGenerationError'
    this.rawResponse = opts.rawResponse
    this.offendingSlide = opts.offendingSlide
  }
}

// ── Constants ─────────────────────────────────────────────────

export const BODY_COPY_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 2000

const MIDDLE_SLIDE_NUMBERS: readonly MiddleSlideNumber[] = [2, 3, 4, 5, 6, 7] as const
const SLIDE_KEY_RE = /^slide_([2-7])$/

const EM_DASH = '\u2014'
const EN_DASH = '\u2013'

// ── Characteristics computation ───────────────────────────────

export function computeCharacteristics(dataPoints: DataPoint[]): GraphCharacteristics {
  if (dataPoints.length === 0) {
    throw new Error('computeCharacteristics: dataPoints is empty')
  }

  let minIdx = 0
  let maxIdx = 0
  for (let i = 1; i < dataPoints.length; i++) {
    if (dataPoints[i].s < dataPoints[minIdx].s) minIdx = i
    if (dataPoints[i].s > dataPoints[maxIdx].s) maxIdx = i
  }
  const lowest = dataPoints[minIdx].s
  const peakHeight = dataPoints[maxIdx].s
  const peakTime = dataPoints[maxIdx].t
  const runtime = dataPoints[dataPoints.length - 1].t

  // dropSeverity: how far the lowest point dips.
  // < 4.0 → dramatic; < 6.0 → moderate (crosses the red-dot threshold); else mild.
  let dropSeverity: GraphCharacteristics['dropSeverity']
  if (lowest < 4.0) dropSeverity = 'dramatic'
  else if (lowest < 6.0) dropSeverity = 'moderate'
  else dropSeverity = 'mild'

  // recoveryShape: behaviour from the lowest beat forward.
  // sharp: next point after the low rises ≥ 2.0 within 15 minutes.
  // gradual: rises ≥ 1.0 above the low at some later point.
  // none: never rises ≥ 1.0, or the low is the final beat.
  let recoveryShape: GraphCharacteristics['recoveryShape'] = 'none'
  if (minIdx < dataPoints.length - 1) {
    let sharp = false
    let gradual = false
    for (let i = minIdx + 1; i < dataPoints.length; i++) {
      const delta = dataPoints[i].s - lowest
      const dt = dataPoints[i].t - dataPoints[minIdx].t
      if (delta >= 2.0 && dt <= 15) sharp = true
      if (delta >= 1.0) gradual = true
    }
    if (sharp) recoveryShape = 'sharp'
    else if (gradual) recoveryShape = 'gradual'
  }

  // peakIsLate: peak sits in the last 40% of runtime.
  const peakIsLate = runtime > 0 && peakTime >= runtime * 0.6

  // redDotCount: points strictly below 6.0.
  let redDotCount = 0
  for (const p of dataPoints) {
    if (p.s < 6.0) redDotCount++
  }

  // endingDirection: compare final beat to the first beat that falls inside
  // the last 15% of runtime. +0.5 → up, -0.5 → down, else flat.
  let endingDirection: GraphCharacteristics['endingDirection'] = 'flat'
  if (dataPoints.length >= 2 && runtime > 0) {
    const windowStart = runtime * 0.85
    let windowIdx = dataPoints.length - 1
    for (let i = 0; i < dataPoints.length; i++) {
      if (dataPoints[i].t >= windowStart) {
        windowIdx = i
        break
      }
    }
    const last = dataPoints[dataPoints.length - 1].s
    const first = dataPoints[windowIdx].s
    const delta = last - first
    if (delta >= 0.5) endingDirection = 'up'
    else if (delta <= -0.5) endingDirection = 'down'
  }

  return {
    dropSeverity,
    recoveryShape,
    peakHeight,
    peakIsLate,
    redDotCount,
    endingDirection,
  }
}

// ── Prompt construction ───────────────────────────────────────

export function buildSystemPrompt(): string {
  return `You are a thoughtful film critic writing body copy for Cinemagraphs, a brand that visualizes how audience sentiment shifts across a film's runtime as a graph of scored beats. Each post is a carousel of 8 slides. Slides 2 through 7 each highlight a single beat on the graph. Your job is to write the short body copy that sits under the graph on those middle slides.

## Voice

- Short declarative sentences. Avoid metaphor. Avoid ornamental phrasing.
- Sharp critic, not essayist. Observational, not promotional. Direct, slightly editorial.
- Target cadence: lines like "The only red dot in the film." and "Audiences hate it, even knowing the plot needs it." Punchy, confident, concrete.
- Do NOT use soft or flowery phrases like "clearing its throat", "finding its footing", "earns its keep", "a runway not a return to baseline", "choose resolution over elation". These are too literary for this voice.

## Length

- Sentence count: hard maximum of 3 sentences per slide. Two is often better than three.
- Sentence length: hard maximum of 18 words per sentence. Most should be 8-14 words. Short sentences are part of the voice.
- Word count: 25-40 words total per slide. Concision is non-negotiable.

## Plot knowledge

- When you know specific plot details about a film (characters, scenes, story beats), USING THEM is preferred over abstract graph commentary. Specific names and moments are what make body copy memorable.
- The v4 reference for Project Hail Mary names Ryland, Rocky, Eva Stratt, the suicide mission, the spacesuit rescue. These are what make slides 4, 5, and 6 land. If you can name the moment, name it. Score-shape commentary is the fallback for films you do not know, not the default.
- If you know the film, do not write vague descriptions of what happens. "Something resets the emotional register" is forbidden; name what actually happens. "Rocky's spacecraft appears at Tau Ceti" is correct. "Eva Stratt drugs Ryland" is correct. Specificity is the brand.
- If you do NOT know specific details, describe the score shape concretely without inventing events. Do NOT use placeholders like "something happens", "the spell breaks", "something on screen shifts". Describe the shape: magnitude of change, pacing, relationship to other beats, position within the runtime.
- Do not name characters, locations, or plot points unless you genuinely know them from the film or they are given in the user prompt.

## No generalizations

- Speak only about THIS film's data and (if known) THIS film's plot.
- Do not make general claims about how audiences react, how endings work, or what kinds of films do what. No lines like "endings that choose X tend to Y" or "films with this shape usually...".
- No commentary about filmmaking in the abstract. The subject is always this specific film at this specific beat.

## Do not anthropomorphize the graph

- The graph is not an actor. Do not write sentences like "The graph earns its tension", "The graph is building toward something", "The graph does not collapse", "The graph shows no hesitation". These are filler.
- Either say what happens in the film, or say what the score IS at this beat. The graph does not do things; the film does, and the score reflects it.

## Hard rules

- Sentence case always. No Title Case. No ALL CAPS in body copy.
- No em dashes (\u2014) and no en dashes (\u2013). Use commas, periods, parentheses, or split into shorter sentences instead. This is a strict rule; responses containing these characters are rejected.
- Every slide's body copy MUST reference the highlighted beat's score by exact value (for example "5.8", not "around 6", not "the upper fives").
- Use concrete numbers from the data where they sharpen the point, but sparingly. The copy is prose, not a readout.
- Never reference internal classifications by name. Do not write "drop severity is mild", "recovery shape is sharp", "red dot count", "peak is late", or "ending direction is down". These are inputs you receive; they are not for the reader. Translate them into plain observation.
- Do not begin slide 2 with "[character] wakes up" or any other repeated opening pattern. Vary sentence structures across the six slides. No two slides should open with the same grammatical move.
- For slides 4, 5, 6 in particular, tie the highlighted beat to the surrounding shape of the graph. These slides should feel connected, not isolated.
- Do not write slide numbers, pill labels, or headlines in the body copy itself. The chrome is rendered separately.
- Do not use hedging ("almost", "kinda", "sort of"). Be direct.

## Rhythm patterns

Use these as shape guides for cadence, not as templates to fill in. Mix and match across the six slides; never reuse the same rhythm twice in a row.

- Rhythm A: short observation. Score reference. Implication.
- Rhythm B: score reference at the start. One concrete detail. What it means.
- Rhythm C: setup detail. Score arrival. Tie back to a previous beat.
- Rhythm D: framing statement. Two short sentences of consequence. Land on the number.

## Output format

Return ONLY a single JSON object, no markdown fences, no preamble, no trailing text. Schema:

{
  "slide_2": "body copy for slide 2",
  "slide_3": "body copy for slide 3",
  "slide_4": "body copy for slide 4",
  "slide_5": "body copy for slide 5",
  "slide_6": "body copy for slide 6",
  "slide_7": "body copy for slide 7"
}

All six keys are required. Each value is a plain string (no nested objects, no arrays).`
}

export function buildUserPrompt(
  input: GenerateBodyCopyInput,
  characteristics: GraphCharacteristics,
): string {
  const film = {
    title: input.filmTitle,
    year: input.filmYear,
    runtimeMinutes: input.runtimeMinutes,
    criticsScore: input.criticsScore,
  }
  const dataPoints = input.dataPoints.map((p) => ({ t: p.t, s: p.s }))
  const slides = input.slides.map((s) => ({
    slideNumber: s.slideNumber,
    pillLabel: s.pillLabel,
    beatTimestamp: s.beatTimestamp,
    beatScore: s.beatScore,
    beatColor: s.beatColor,
  }))

  return `Write body copy for slides 2 through 7 of a Cinemagraphs carousel for the following film. Return ONLY the JSON object described in the system prompt.

Film:
${JSON.stringify(film, null, 2)}

Graph data points (t in minutes, s is the sentiment score 1.0-10.0):
${JSON.stringify(dataPoints, null, 2)}

Computed graph characteristics:
${JSON.stringify(characteristics, null, 2)}

Slide beat contexts (each slide highlights one beat):
${JSON.stringify(slides, null, 2)}

Remember:
- Every body-copy string must reference its highlighted beat's exact score.
- No em dashes, no en dashes. Sentence case. Two to three sentences each.
- Slides 4, 5, 6 should chain: the drop, the recovery off that drop, and the peak that the recovery builds to.
- Do not invent plot details beyond what is provided above.`
}

// ── API call ──────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY || '',
    })
  }
  return anthropicClient
}

function validateSlidesArg(slides: SlideBeatContext[]): void {
  if (slides.length !== MIDDLE_SLIDE_NUMBERS.length) {
    throw new Error(
      `generateBodyCopy: slides must have exactly 6 entries (slides 2-7), got ${slides.length}`,
    )
  }
  for (let i = 0; i < MIDDLE_SLIDE_NUMBERS.length; i++) {
    if (slides[i].slideNumber !== MIDDLE_SLIDE_NUMBERS[i]) {
      throw new Error(
        `generateBodyCopy: slides[${i}].slideNumber must be ${MIDDLE_SLIDE_NUMBERS[i]}, got ${slides[i].slideNumber}`,
      )
    }
  }
}

function parseBodyCopyResponse(raw: string): Record<MiddleSlideNumber, string> {
  const cleaned = raw
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    throw new BodyCopyGenerationError(
      `Failed to parse JSON response: ${(err as Error).message}`,
      { rawResponse: raw },
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BodyCopyGenerationError(
      'Response is not a JSON object',
      { rawResponse: raw },
    )
  }

  const obj = parsed as Record<string, unknown>
  const out = {} as Record<MiddleSlideNumber, string>
  for (const n of MIDDLE_SLIDE_NUMBERS) {
    const key = `slide_${n}`
    const val = obj[key]
    if (typeof val !== 'string' || val.trim() === '') {
      throw new BodyCopyGenerationError(
        `Response missing or empty key "${key}"`,
        { rawResponse: raw, offendingSlide: n },
      )
    }
    out[n] = val
  }

  for (const n of MIDDLE_SLIDE_NUMBERS) {
    const text = out[n]
    if (text.includes(EM_DASH) || text.includes(EN_DASH)) {
      throw new BodyCopyGenerationError(
        'Generated copy contains forbidden dash character',
        { rawResponse: raw, offendingSlide: n },
      )
    }
  }

  return out
}

export async function generateBodyCopy(
  input: GenerateBodyCopyInput,
): Promise<GenerateBodyCopyOutput> {
  validateSlidesArg(input.slides)

  const characteristics = computeCharacteristics(input.dataPoints)
  const system = buildSystemPrompt()
  const user = buildUserPrompt(input, characteristics)

  const message = await getAnthropicClient().messages.create({
    model: BODY_COPY_MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.4,
    system: [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: user }],
  })

  const responseText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('')

  const bodyCopy = parseBodyCopyResponse(responseText)

  const totalTokens =
    (message.usage?.input_tokens ?? 0) +
    (message.usage?.output_tokens ?? 0) +
    (message.usage?.cache_creation_input_tokens ?? 0) +
    (message.usage?.cache_read_input_tokens ?? 0)

  return {
    bodyCopy,
    characteristics,
    modelUsed: BODY_COPY_MODEL,
    totalTokens,
  }
}

// Exported for tests to verify the response parser in isolation.
export { parseBodyCopyResponse }
// Re-export for callers that want to build user prompts without invoking the full generator.
export { SLIDE_KEY_RE }
