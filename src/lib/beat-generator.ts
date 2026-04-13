import Anthropic from '@anthropic-ai/sdk'
import { pipelineLogger } from './logger'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY || '',
})

export interface StoryBeat {
  label: string
  timeStart: number
  timeEnd: number
  timeMidpoint: number
}

function buildBeatPrompt(
  filmTitle: string,
  filmYear: number,
  runtime: number,
  plotText: string
): string {
  return `You are a film story analyst. Read the plot summary below for "${filmTitle}" (${filmYear}) and extract 6-8 key story beats that would let a moviegoer mark where big emotional moments happen in the film.

## Film Information
- Title: ${filmTitle}
- Year: ${filmYear}
- Runtime: ${runtime} minutes

## Plot Summary

${plotText.slice(0, 6000)}

## Instructions

1. Pick 6-8 of the most memorable, specific story moments from this plot. Think: moments audiences talk about after the credits roll.
2. Each beat needs a CONVERSATIONAL label — plain language a moviegoer would recognize. Reference specific scenes, characters, or events from the plot when possible. Examples:
   - "Meeting the main characters"
   - "The heist goes wrong"
   - "She finds out the truth about her father"
   - "The big chase through the city"
   - "How it ends"
   DO NOT use screenwriting jargon like "Act One", "Inciting Incident", "Midpoint", "Climax", "Denouement", "Rising Action". Avoid generic labels like "The beginning" or "A twist happens".
3. Spoilers are ALLOWED and encouraged — this is for people who have seen the film.
4. Assign each beat a timeStart and timeEnd based on where it occurs in a ${runtime}-minute film. Spread them across the full runtime (0 to ${runtime}), roughly proportional to where the event happens in the plot. The first beat should start near 0 and the last beat should end near ${runtime}. Each beat can span 3-15 minutes.
5. Compute timeMidpoint as the midpoint between timeStart and timeEnd, rounded to the nearest whole minute.
6. Beats should be ordered chronologically and should not overlap.

## Required Output Format

Return ONLY valid JSON (no markdown, no code fences, no explanation) matching this exact structure:

{
  "beats": [
    {
      "label": "Meeting the crew",
      "timeStart": 0,
      "timeEnd": 8,
      "timeMidpoint": 4
    },
    {
      "label": "The first job",
      "timeStart": 15,
      "timeEnd": 25,
      "timeMidpoint": 20
    }
  ]
}`
}

function validateBeats(raw: unknown, runtime: number): StoryBeat[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Response is not an object')
  }
  const obj = raw as { beats?: unknown }
  if (!Array.isArray(obj.beats)) {
    throw new Error('Missing or invalid beats array')
  }
  if (obj.beats.length < 4 || obj.beats.length > 10) {
    throw new Error(`Expected 4-10 beats, got ${obj.beats.length}`)
  }

  const beats: StoryBeat[] = []
  for (const b of obj.beats) {
    if (!b || typeof b !== 'object') {
      throw new Error('Beat is not an object')
    }
    const beat = b as { label?: unknown; timeStart?: unknown; timeEnd?: unknown; timeMidpoint?: unknown }
    if (typeof beat.label !== 'string' || beat.label.trim().length === 0) {
      throw new Error('Beat missing label')
    }
    if (typeof beat.timeStart !== 'number' || typeof beat.timeEnd !== 'number' || typeof beat.timeMidpoint !== 'number') {
      throw new Error('Beat timestamps must be numbers')
    }
    if (beat.timeStart < 0 || beat.timeEnd > runtime + 5 || beat.timeStart >= beat.timeEnd) {
      throw new Error(`Invalid beat range: ${beat.timeStart}-${beat.timeEnd} for runtime ${runtime}`)
    }
    beats.push({
      label: beat.label.trim(),
      timeStart: Math.max(0, Math.round(beat.timeStart)),
      timeEnd: Math.min(runtime, Math.round(beat.timeEnd)),
      timeMidpoint: Math.round(beat.timeMidpoint),
    })
  }

  // Ensure chronological order
  beats.sort((a, b) => a.timeStart - b.timeStart)
  return beats
}

/**
 * Generate story beats from a plot summary using Claude Haiku 4.5.
 * Returns an empty array on failure (does not throw) so callers can fall back gracefully.
 */
export async function generateBeatsFromPlot(
  filmTitle: string,
  filmYear: number,
  runtime: number,
  plotText: string
): Promise<StoryBeat[]> {
  if (!plotText || plotText.trim().length < 100) {
    pipelineLogger.warn(
      { filmTitle, filmYear, plotLength: plotText?.length ?? 0 },
      'Plot text too short for beat generation'
    )
    return []
  }

  const prompt = buildBeatPrompt(filmTitle, filmYear, runtime, plotText)

  let lastError: Error | null = null
  let lastRawResponse: string | undefined

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const currentPrompt = attempt === 0
        ? prompt
        : `IMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON — no markdown fences, no preamble, no trailing text.\n\n${prompt}`

      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: currentPrompt }],
      })

      const responseText = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')

      lastRawResponse = responseText

      const cleaned = responseText
        .replace(/^```json?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim()

      const parsed = JSON.parse(cleaned)
      const beats = validateBeats(parsed, runtime)

      pipelineLogger.info(
        { filmTitle, filmYear, beatCount: beats.length },
        'Generated story beats from Wikipedia plot'
      )
      return beats
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      pipelineLogger.warn(
        { filmTitle, filmYear, attempt: attempt + 1, error: lastError.message },
        `Beat generation attempt ${attempt + 1} failed`
      )
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  pipelineLogger.error(
    { filmTitle, filmYear, rawResponse: lastRawResponse?.slice(0, 500), error: lastError?.message },
    'Beat generation failed after 2 attempts, returning empty array'
  )
  return []
}
