import { prisma } from '@/lib/prisma'
import { composeSlide, type FilmData } from './slide-composer'
import type { DataPoint } from './graph-renderer'
import { resolvePerSlideBackdrop } from './slide-backdrop-resolver'
import { runtimeLabel } from './render-middle-slide'
import type { SentimentDataPoint } from '@/lib/types'

export class RenderCoverSlideError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 500) {
    super(message)
    this.name = 'RenderCoverSlideError'
    this.code = code
    this.status = status
  }
}

export type RenderCoverSlideParams = {
  draftId: string
  // Overrides the backdrop URL for slide 1 before persistence.
  //   undefined → use per-slide resolver chain (slideBackdropsJson then draft)
  //   string    → use this URL (unsaved preview from stills PATCH)
  //   null      → explicitly clear to draft-wide backdropUrl fallback
  slideBackdropOverride?: string | null
}

// Re-compose the cover slide (position 1) for an existing draft row. Reads
// the film and backdrop URL from the DB, then calls composeSlide. Returns the
// PNG buffer. Never persists.
//
// Used by the stills PATCH route on slide 1: it calls this with an override
// and only writes to slideBackdropsJson if this returns successfully.
export async function renderCoverSlide(
  params: RenderCoverSlideParams,
): Promise<Buffer> {
  const { draftId, slideBackdropOverride } = params

  const draft = await prisma.carouselDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      filmId: true,
      format: true,
      backdropUrl: true,
      slideBackdropsJson: true,
    },
  })
  if (!draft) {
    throw new RenderCoverSlideError('DRAFT_NOT_FOUND', 'Draft not found', 404)
  }
  if (draft.format !== '4x5' && draft.format !== '9x16') {
    throw new RenderCoverSlideError(
      'INVALID_FORMAT',
      `Draft format is invalid: ${draft.format}`,
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
    throw new RenderCoverSlideError('FILM_NOT_FOUND', 'Film not found')
  }
  if (!film.sentimentGraph) {
    throw new RenderCoverSlideError(
      'NO_SENTIMENT_GRAPH',
      'Film has no sentiment graph',
    )
  }
  if (!film.runtime || film.runtime <= 0) {
    throw new RenderCoverSlideError('NO_RUNTIME', 'Film runtime is missing')
  }

  const sentimentBeats = (Array.isArray(film.sentimentGraph.dataPoints)
    ? film.sentimentGraph.dataPoints
    : []) as unknown as SentimentDataPoint[]
  const beats = [...sentimentBeats].sort((a, b) => a.timeMidpoint - b.timeMidpoint)
  const dataPoints: DataPoint[] = beats.map((b) => ({ t: b.timeMidpoint, s: b.score }))

  const year = film.releaseDate
    ? new Date(film.releaseDate).getFullYear()
    : new Date().getFullYear()
  const filmData: FilmData = {
    title: film.title,
    year,
    runtime: runtimeLabel(film.runtime),
    genres: film.genres ?? [],
    criticsScore: film.sentimentGraph.overallScore,
    dataPoints,
    totalRuntimeMinutes: film.runtime,
  }

  const overrideProvided = slideBackdropOverride !== undefined
  const resolvedBackdrop = overrideProvided
    ? slideBackdropOverride
    : resolvePerSlideBackdrop(draft.slideBackdropsJson, 1)

  const backgroundImage = resolvedBackdrop ?? draft.backdropUrl ?? undefined

  try {
    return await composeSlide({
      film: filmData,
      slideNumber: 1,
      format: draft.format as '4x5' | '9x16',
      backgroundImage,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new RenderCoverSlideError('COMPOSER_FAILED', msg)
  }
}
