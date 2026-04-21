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

// Narrative role preserved from slot-selection so the model can tell a drop
// from a peak when writing copy. 'fallback' means the beat was picked by
// chronological window rather than narrative fit.
export type SlideOriginalRole =
  | 'opening'
  | 'setup'
  | 'drop'
  | 'recovery'
  | 'peak'
  | 'ending'
  | 'fallback'

export type SlideBeatContext = {
  slideNumber: MiddleSlideNumber
  // Optional AI-derived pill; always present in response. The legacy field
  // below seeds a fallback when the film's story-beat label is missing.
  pillLabel: string
  beatTimestamp: number
  beatScore: number
  beatColor: 'red' | 'gold' | 'teal'
  // Narrative role the slot was picked under. 'fallback' if this beat was
  // chosen by chronological window rather than narrative fit.
  originalRole: SlideOriginalRole
  // Full story-beat label for the beat at this timestamp, pulled from the
  // film's sentiment graph. Empty string means "no story beat at this time"
  // — the generator should fall back to the generic role label in that case.
  storyBeatName: string
}

export type SlideCopy = {
  pill: string
  // Short serif headline rendered under the pill. Supporting copy — emotional
  // framing in 3-6 words. NOT a restatement of the pill or storyBeatName.
  headline: string
  body: string
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
  // Indexed by MiddleSlideNumber. Each entry holds both the AI-shortened pill
  // and the body copy for that slide.
  slideCopy: Record<MiddleSlideNumber, SlideCopy>
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
  return `You are a thoughtful film critic writing body copy for Cinemagraphs, a brand that visualizes how audience sentiment shifts across a film's runtime as a graph of scored beats. Each post is a carousel of 8 slides. Slides 2 through 7 each highlight a single beat on the graph. Your job is to write a short pill label, a short serif headline, AND the body copy that sits under the graph on those middle slides.

## Voice

- Short declarative sentences. Avoid metaphor. Avoid ornamental phrasing.
- Sharp critic, not essayist. Observational, not promotional. Direct, slightly editorial.
- Target cadence: lines like "The only red dot in the film." and "Audiences hate it, even knowing the plot needs it." Punchy, confident, concrete.
- Do NOT use soft or flowery phrases like "clearing its throat", "finding its footing", "earns its keep", "a runway not a return to baseline", "choose resolution over elation". These are too literary for this voice.

## Length

- Sentence count: hard maximum of 3 sentences per slide. Two is often better than three.
- Sentence length: hard maximum of 18 words per sentence. Most should be 8-14 words. Short sentences are part of the voice.
- Word count: 30-50 words total per slide. Sentence count serves content; do not pad to reach three sentences.

## Plot knowledge

- When you know specific plot details about a film (characters, scenes, story beats), USING THEM is preferred over abstract graph commentary. Specific names and moments are what make body copy memorable.
- The v4 reference for Project Hail Mary names Ryland, Rocky, Eva Stratt, the suicide mission, the spacesuit rescue. These are what make slides 4, 5, and 6 land. If you can name the moment, name it. Score-shape commentary is the fallback for films you do not know, not the default.
- If you know the film, do not write vague descriptions of what happens. "Something resets the emotional register" is forbidden; name what actually happens. "Rocky's spacecraft appears at Tau Ceti" is correct. "Eva Stratt drugs Ryland" is correct. Specificity is the brand.
- If you do NOT know specific details, describe the score shape concretely without inventing events. Do NOT use placeholders like "something happens", "the spell breaks", "something on screen shifts". Describe the shape: magnitude of change, pacing, relationship to other beats, position within the runtime.
- Do not name characters, locations, or plot points unless you genuinely know them from the film or they are given in the user prompt.

## Sentence content priority

Each slide's body copy should cover two things:

1. What happens at this beat in the film — use the provided storyBeatName to ground the scene, but make the prose vivid, not a restatement.
2. Why the score is what it is — the emotional or dramatic reason audiences scored this moment the way they did.

Do not restate the storyBeatName verbatim. Expand on it with scene context, then connect it to the score.

Good example:
  storyBeatName: "Rocky breaks his spacesuit to save unconscious Grace"
  body: "Rocky ruptures his own suit to save Grace when she blacks out. {{teal:9.5}} at 1h 55m is the film's peak because audiences watched an alien commit the ultimate sacrifice for a human stranger."

Bad example (too close to the label, no reasoning):
  "Rocky breaks his spacesuit to save unconscious Grace. {{teal:9.5}} is the peak."

## Forbidden sentence patterns

Do not write summary-philosophical closing sentences that sound meaningful but say nothing. Examples to avoid verbatim or in spirit:

- "The dread is present, but so is the investment."
- "It is both a loss and a beginning."
- "What it sacrifices in X, it gains in Y."
- "The film earns what it asks for."
- "Resonance over relief." (or any "X over Y" construction)

Every sentence must either describe a specific scene, state a specific data point, or draw an explicit connection between beats. If you cannot make a sentence do real work, cut it — two sentences is better than three with a filler closer.

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

## Format markers for score values

Every time you cite a score, wrap the numeric value in a color marker so the copy visually ties to its dot. The color must match the dot color for that score:

- Scores below 6.0 use red: {{red:5.8}}
- Scores from 6.0 up to (but not including) 8.0 use gold: {{gold:7.4}}
- Scores from 8.0 upward use teal: {{teal:9.5}}

Examples:
- "The score hits {{teal:9.5}}."
- "{{red:5.8}} is the lowest point in the film."
- "A jump from {{red:5.8}} to {{teal:8.7}} across ten minutes."

Markers wrap only the numeric value itself, never the surrounding words or punctuation. Do not nest markers. Do not use markers on anything other than score values (not on timestamps, not on runtimes, not on years).

## Time format

Use numerals for every time reference. Write "1h 15m", "25 minutes", "0m-5m". Do not spell out numbers ("one hour fifteen minutes", "twenty-five minutes"). This keeps the body copy visually consistent with the pill labels above each slide, which are also in numerals.

## Pill labels

Each slide also has a short pill label rendered above the headline. Derive the pill from the film's actual story beat for that timestamp (provided as storyBeatName in the user prompt). Do not invent; compress.

Pill constraints:
- Maximum 30 characters including spaces. The renderer uppercases the pill, so write in sentence case or mixed case.
- Must be derived from the provided storyBeatName. Strip articles, minor characters, and secondary clauses until the name fits.
- Describe the beat, not the slot. Do NOT use generic labels like "THE OPENING", "THE SETUP", "THE DROP", "RECOVERY", "THE PEAK", "THE ENDING" unless the storyBeatName is truly absent.
- No punctuation other than apostrophes inside names. No em dashes, no en dashes, no quotes.

Example transformations:
- storyBeatName: "Eva Stratt reveals the suicide mission to Tau Ceti" → pill: "Stratt reveals the mission"
- storyBeatName: "Rocky breaks his spacesuit to save unconscious Grace" → pill: "Rocky saves Grace"
- storyBeatName: "Grace is drugged and forcibly loaded onto Hail Mary" → pill: "Grace forced onto the ship"

If storyBeatName is an empty string for a given slide, use one of these generic labels as a fallback, matched to the slide's originalRole:
- opening → "The opening"
- setup → "The setup"
- drop → "The drop"
- recovery → "Recovery"
- peak → "The peak"
- ending → "The ending"
- fallback → "This beat"

## Headlines

Each slide has a short serif headline rendered below the pill. The headline is SUPPORTING copy — emotional framing for the beat in 3 to 6 words. It is NOT a restatement of the storyBeatName (that's the pill's job) and it is NOT a plot summary. Think of it as a caption that captures the vibe or the stakes of the moment.

Headline constraints:
- 3 to 6 words. Short.
- Sentence case with a trailing period. Examples: "Already inside the world.", "No score survives this.", "The floor is gone."
- Emotional or observational framing. Specific to the beat, not the slot.
- Must NOT repeat the pill or the storyBeatName verbatim. If the pill names the scene, the headline frames the feeling.
- Do NOT use these generic filler phrases (they sound like slot-label defaults, not editorial):
  - "Where the story starts"
  - "How it lands"
  - "Then the floor drops out"
  - "Then it finds its footing"
  - "The audience settles in"
  - "Another beat in the shape"
  - "How it begins"
  - "The film's highest moment"
  - "Straight into the mystery"
- If the beat's actual score behavior contradicts its slot role (for example, originalRole is "drop" but the score sits near a peak, or originalRole is "recovery" but the score is one of the lowest), TRUST THE DATA. Write the headline to match what the score is actually doing, not what the slot was named. A slot named "drop" at score 9.2 should read like a peak moment.

## Output format

Return ONLY a single JSON object, no markdown fences, no preamble, no trailing text. Schema:

{
  "slide_2": { "pill": "...", "headline": "...", "body": "..." },
  "slide_3": { "pill": "...", "headline": "...", "body": "..." },
  "slide_4": { "pill": "...", "headline": "...", "body": "..." },
  "slide_5": { "pill": "...", "headline": "...", "body": "..." },
  "slide_6": { "pill": "...", "headline": "...", "body": "..." },
  "slide_7": { "pill": "...", "headline": "...", "body": "..." }
}

All six keys are required. Each value is an object with exactly three string fields: pill, headline, and body.`
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
  // scoreDelta = change from the previous chronological slide's beat score.
  // Lets the model cross-check its drop/peak claims against the actual
  // local movement: a slot labeled "drop" with a positive delta means the
  // score is actually rising at that moment, and the copy should reflect
  // that rather than the slot label.
  const slides = input.slides.map((s, i) => {
    const prev = i > 0 ? input.slides[i - 1] : null
    const scoreDelta = prev ? +(s.beatScore - prev.beatScore).toFixed(2) : 0
    return {
      slideNumber: s.slideNumber,
      originalRole: s.originalRole,
      storyBeatName: s.storyBeatName,
      beatTimestamp: s.beatTimestamp,
      beatScore: s.beatScore,
      beatColor: s.beatColor,
      scoreDelta,
    }
  })

  return `Write pill labels, headlines, and body copy for slides 2 through 7 of a Cinemagraphs carousel for the following film. Return ONLY the JSON object described in the system prompt.

Film:
${JSON.stringify(film, null, 2)}

Graph data points (t in minutes, s is the sentiment score 1.0-10.0):
${JSON.stringify(dataPoints, null, 2)}

Computed graph characteristics:
${JSON.stringify(characteristics, null, 2)}

Slide beat contexts (each slide highlights one beat, ordered chronologically; scoreDelta is the change from the previous slide's beat score and is 0 for the first slide):
${JSON.stringify(slides, null, 2)}

Remember:
- Every body-copy string must reference its highlighted beat's exact score, wrapped in the correct color marker.
- Derive each pill from the storyBeatName, compressed to 30 characters or fewer. Fall back to the generic role label only when storyBeatName is empty.
- Headline is 3-6 words, sentence case with a period, NOT a restatement of the pill. Avoid the forbidden generic filler phrases in the system prompt.
- When scoreDelta contradicts the slot's originalRole (e.g., originalRole "drop" with a positive delta, or originalRole "peak" with a negative delta), trust the data and write the headline and body to match what the score is actually doing.
- No em dashes, no en dashes. Sentence case. Two to three sentences each, 30-50 words.
- Body copy must describe the scene AND the reason the score is what it is. Do not close with a summary-philosophical sentence.
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

// Try three progressively-more-forgiving strategies to recover JSON from a
// Claude response: raw, substring between first `{` and last `}`, and finally
// a triple-backtick fence strip (with or without a `json` language tag).
function tryParseJsonWithFallbacks(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {}

  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1))
    } catch {}
  }

  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i)
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim())
    } catch {}
  }

  throw new BodyCopyGenerationError(
    `Failed to parse body copy JSON response (tried raw, substring, and code-fence). Raw response: ${raw}`,
    { rawResponse: raw },
  )
}

const MAX_PILL_LENGTH = 30
// Headline is short editorial framing (3-6 words). 80 chars leaves room for
// longer words while still catching runaway generations.
const MAX_HEADLINE_LENGTH = 80

function parseBodyCopyResponse(raw: string): Record<MiddleSlideNumber, SlideCopy> {
  const parsed = tryParseJsonWithFallbacks(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BodyCopyGenerationError(
      'Response is not a JSON object',
      { rawResponse: raw },
    )
  }

  const obj = parsed as Record<string, unknown>
  const out = {} as Record<MiddleSlideNumber, SlideCopy>
  for (const n of MIDDLE_SLIDE_NUMBERS) {
    const key = `slide_${n}`
    const val = obj[key]
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw new BodyCopyGenerationError(
        `Response missing or malformed key "${key}" — expected object with pill, headline, and body`,
        { rawResponse: raw, offendingSlide: n },
      )
    }
    const entry = val as Record<string, unknown>
    const pill = entry.pill
    const headline = entry.headline
    const body = entry.body
    if (typeof pill !== 'string' || pill.trim() === '') {
      throw new BodyCopyGenerationError(
        `Response key "${key}" missing or empty "pill"`,
        { rawResponse: raw, offendingSlide: n },
      )
    }
    if (typeof headline !== 'string' || headline.trim() === '') {
      throw new BodyCopyGenerationError(
        `Response key "${key}" missing or empty "headline"`,
        { rawResponse: raw, offendingSlide: n },
      )
    }
    if (typeof body !== 'string' || body.trim() === '') {
      throw new BodyCopyGenerationError(
        `Response key "${key}" missing or empty "body"`,
        { rawResponse: raw, offendingSlide: n },
      )
    }
    out[n] = { pill: pill.trim(), headline: headline.trim(), body }
  }

  for (const n of MIDDLE_SLIDE_NUMBERS) {
    const { pill, headline, body } = out[n]
    if (body.includes(EM_DASH) || body.includes(EN_DASH)) {
      throw new BodyCopyGenerationError(
        'Generated copy contains forbidden dash character',
        { rawResponse: raw, offendingSlide: n },
      )
    }
    if (pill.includes(EM_DASH) || pill.includes(EN_DASH)) {
      throw new BodyCopyGenerationError(
        'Generated pill contains forbidden dash character',
        { rawResponse: raw, offendingSlide: n },
      )
    }
    if (headline.includes(EM_DASH) || headline.includes(EN_DASH)) {
      throw new BodyCopyGenerationError(
        'Generated headline contains forbidden dash character',
        { rawResponse: raw, offendingSlide: n },
      )
    }
    if (pill.length > MAX_PILL_LENGTH) {
      throw new BodyCopyGenerationError(
        `Generated pill exceeds ${MAX_PILL_LENGTH} characters (got ${pill.length}): "${pill}"`,
        { rawResponse: raw, offendingSlide: n },
      )
    }
    if (headline.length > MAX_HEADLINE_LENGTH) {
      throw new BodyCopyGenerationError(
        `Generated headline exceeds ${MAX_HEADLINE_LENGTH} characters (got ${headline.length}): "${headline}"`,
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

  const slideCopy = parseBodyCopyResponse(responseText)

  const totalTokens =
    (message.usage?.input_tokens ?? 0) +
    (message.usage?.output_tokens ?? 0) +
    (message.usage?.cache_creation_input_tokens ?? 0) +
    (message.usage?.cache_read_input_tokens ?? 0)

  return {
    slideCopy,
    characteristics,
    modelUsed: BODY_COPY_MODEL,
    totalTokens,
  }
}

// Exported for tests to verify the response parser in isolation.
export { parseBodyCopyResponse }
// Re-export for callers that want to build user prompts without invoking the full generator.
export { SLIDE_KEY_RE }
