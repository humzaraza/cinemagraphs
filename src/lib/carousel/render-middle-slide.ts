import { prisma } from '@/lib/prisma'
import { computeDotColor, type DataPoint } from './graph-renderer'
import { composeSlide, type FilmData, type MiddleSlideContent } from './slide-composer'
import type { MiddleSlideNumber, SlideCopy } from './body-copy-generator'
import type { OriginalRole } from './slot-selection'
import type { SentimentDataPoint } from '@/lib/types'

const ROLE_PILL_FALLBACK: Record<OriginalRole, string> = {
  opening: 'THE OPENING',
  setup: 'THE SETUP',
  drop: 'THE DROP',
  recovery: 'RECOVERY',
  peak: 'THE PEAK',
  ending: 'THE ENDING',
  fallback: 'THIS BEAT',
}

const ROLE_HEADLINE: Record<OriginalRole, string> = {
  opening: 'Where the story starts.',
  setup: 'The audience settles in.',
  drop: 'Then the floor drops out.',
  recovery: 'Then it finds its footing.',
  peak: "The film's highest moment.",
  ending: 'How it lands.',
  fallback: 'Another beat in the shape.',
}

type SlotSelectionJson = {
  position: number
  kind: string
  originalRole: OriginalRole | null
  beatTimestamp: number | null
  beatScore: number | null
  timestampLabel: string
  collision: boolean
  duplicateTimestamp?: boolean
}

function runtimeLabel(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60)
    const m = minutes - h * 60
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `${minutes}m`
}

// Assemble the displayed pill string matching the POST route's convention:
// `{AI_PILL_OR_FALLBACK_UPPER} · {TIMESTAMP_UPPER}`.
function renderedPill(pillSource: string, timestampLabel: string): string {
  const pill = pillSource.trim()
  const ts = timestampLabel.trim().toUpperCase()
  if (!pill) return ts
  return `${pill.toUpperCase()} · ${ts}`
}

export class RenderMiddleSlideError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'RenderMiddleSlideError'
    this.code = code
  }
}

export type RenderMiddleSlideParams = {
  draftId: string
  slideNum: MiddleSlideNumber
  // If provided, overrides the persisted bodyCopyJson[slideNum] for the render.
  // Used by PATCH (candidate edit) and revert (AI version) before persistence.
  slideCopyOverride?: SlideCopy
}

// Re-compose a single middle slide (2-7) for an existing draft row. Reads the
// film, slot selections, and cached backdrop URL from the DB, then calls
// composeSlide. Returns the PNG buffer. Never persists.
//
// Used by PATCH and revert: they call this with an override, and only write
// to bodyCopyJson if this returns successfully.
export async function renderMiddleSlide(
  params: RenderMiddleSlideParams,
): Promise<Buffer> {
  const { draftId, slideNum, slideCopyOverride } = params

  if (!Number.isInteger(slideNum) || slideNum < 2 || slideNum > 7) {
    throw new RenderMiddleSlideError(
      `slideNum must be an integer in 2..7, got ${slideNum}`,
      'INVALID_SLIDE',
    )
  }

  const draft = await prisma.carouselDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      filmId: true,
      format: true,
      bodyCopyJson: true,
      slotSelectionsJson: true,
      backdropUrl: true,
    },
  })
  if (!draft) {
    throw new RenderMiddleSlideError('Draft not found', 'DRAFT_NOT_FOUND')
  }
  if (draft.format !== '4x5' && draft.format !== '9x16') {
    throw new RenderMiddleSlideError(
      `Draft format is invalid: ${draft.format}`,
      'INVALID_FORMAT',
    )
  }

  const film = await prisma.film.findUnique({
    where: { id: draft.filmId },
    select: {
      id: true,
      title: true,
      releaseDate: true,
      runtime: true,
      genres: true,
      sentimentGraph: { select: { overallScore: true, dataPoints: true } },
    },
  })
  if (!film) {
    throw new RenderMiddleSlideError('Film not found', 'FILM_NOT_FOUND')
  }
  if (!film.sentimentGraph) {
    throw new RenderMiddleSlideError(
      'Film has no sentiment graph',
      'NO_SENTIMENT_GRAPH',
    )
  }
  if (!film.runtime || film.runtime <= 0) {
    throw new RenderMiddleSlideError('Film runtime is missing', 'NO_RUNTIME')
  }

  const sentimentBeats = (Array.isArray(film.sentimentGraph.dataPoints)
    ? film.sentimentGraph.dataPoints
    : []) as unknown as SentimentDataPoint[]
  const beats = [...sentimentBeats].sort((a, b) => a.timeMidpoint - b.timeMidpoint)
  if (beats.length === 0) {
    throw new RenderMiddleSlideError(
      'Film sentiment graph has no beats',
      'NO_BEATS',
    )
  }
  const dataPoints: DataPoint[] = beats.map((b) => ({ t: b.timeMidpoint, s: b.score }))

  const slots = (Array.isArray(draft.slotSelectionsJson)
    ? draft.slotSelectionsJson
    : []) as unknown as SlotSelectionJson[]
  const slot = slots.find((s) => s.position === slideNum)
  if (!slot || slot.beatTimestamp === null) {
    throw new RenderMiddleSlideError(
      `Slot ${slideNum} has no beat in persisted slotSelections`,
      'SLOT_MISSING',
    )
  }

  const beatIndex = beats.findIndex((b) => b.timeMidpoint === slot.beatTimestamp)
  if (beatIndex === -1) {
    throw new RenderMiddleSlideError(
      `Could not locate beat at t=${slot.beatTimestamp} in sentiment graph`,
      'BEAT_NOT_FOUND',
    )
  }

  const bodyCopyJson = (draft.bodyCopyJson ?? {}) as unknown as Record<string, SlideCopy>
  const slideCopy: SlideCopy = slideCopyOverride ?? bodyCopyJson[String(slideNum)]
  if (!slideCopy) {
    throw new RenderMiddleSlideError(
      `No body copy persisted for slide ${slideNum}`,
      'NO_BODY_COPY',
    )
  }

  const role: OriginalRole = slot.originalRole ?? 'fallback'
  const pillSource = slideCopy.pill.trim() !== '' ? slideCopy.pill : ROLE_PILL_FALLBACK[role]
  const headlineSource =
    slideCopy.headline.trim() !== '' ? slideCopy.headline : ROLE_HEADLINE[role]

  const middleContent: MiddleSlideContent = {
    pillLabel: renderedPill(pillSource, slot.timestampLabel),
    headline: headlineSource,
    bodyCopy: slideCopy.body ?? '',
    // renderGraph prepends a neutral anchor at index 0, so the beat's position
    // in the rendered dotPositions array is beatIndex + 1.
    highlightBeatIndex: beatIndex + 1,
  }

  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : new Date().getFullYear()
  const filmData: FilmData = {
    title: film.title,
    year,
    runtime: runtimeLabel(film.runtime),
    genres: film.genres ?? [],
    criticsScore: film.sentimentGraph.overallScore,
    dataPoints,
    totalRuntimeMinutes: film.runtime,
  }

  return composeSlide({
    film: filmData,
    slideNumber: slideNum as 2 | 3 | 4 | 5 | 6 | 7,
    format: draft.format as '4x5' | '9x16',
    middleContent,
    backgroundImage: draft.backdropUrl ?? undefined,
  })
}
