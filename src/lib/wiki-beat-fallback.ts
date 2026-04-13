import { prisma } from '@/lib/prisma'
import { fetchWikipediaPlot } from '@/lib/sources/wikipedia'
import { generateBeatsFromPlot, type StoryBeat } from '@/lib/beat-generator'
import { pipelineLogger } from '@/lib/logger'

export type GenerateWikiBeatsResult =
  | { status: 'skipped_has_graph' }
  | { status: 'skipped_has_beats' }
  | { status: 'skipped_no_plot' }
  | { status: 'skipped_no_year' }
  | { status: 'skipped_generation_failed' }
  | { status: 'generated'; beatCount: number }
  | { status: 'film_not_found' }

/**
 * Generate Wikipedia-sourced story beats for a film and store them.
 *
 * This is a fallback path for films that don't have an NLP sentiment graph yet.
 * It will NOT overwrite existing FilmBeats or generate beats when a SentimentGraph
 * already exists (NLP beats take priority).
 *
 * Pass `force: true` to regenerate beats even when they already exist. SentimentGraph
 * is still respected as a hard skip — NLP graphs always win.
 */
export async function generateAndStoreWikiBeats(
  filmId: string,
  options: { force?: boolean } = {}
): Promise<GenerateWikiBeatsResult> {
  const film = await prisma.film.findUnique({
    where: { id: filmId },
    select: {
      id: true,
      title: true,
      releaseDate: true,
      runtime: true,
      sentimentGraph: { select: { id: true } },
      filmBeats: { select: { id: true } },
    },
  })

  if (!film) {
    return { status: 'film_not_found' }
  }

  if (film.sentimentGraph) {
    pipelineLogger.info(
      { filmId, title: film.title },
      'Skipping wiki beats — sentiment graph already exists'
    )
    return { status: 'skipped_has_graph' }
  }

  if (film.filmBeats && !options.force) {
    return { status: 'skipped_has_beats' }
  }

  if (!film.releaseDate) {
    pipelineLogger.warn(
      { filmId, title: film.title },
      'Cannot generate wiki beats — no release date'
    )
    return { status: 'skipped_no_year' }
  }

  const year = new Date(film.releaseDate).getFullYear()
  const runtime = film.runtime || 120

  const plotText = await fetchWikipediaPlot(film.title, year)
  if (!plotText) {
    return { status: 'skipped_no_plot' }
  }

  const beats = await generateBeatsFromPlot(film.title, year, runtime, plotText)
  if (beats.length === 0) {
    return { status: 'skipped_generation_failed' }
  }

  await prisma.filmBeats.upsert({
    where: { filmId },
    create: {
      filmId,
      beats: beats as unknown as object,
      source: 'wikipedia',
    },
    update: {
      beats: beats as unknown as object,
      source: 'wikipedia',
      generatedAt: new Date(),
    },
  })

  pipelineLogger.info(
    { filmId, title: film.title, beatCount: beats.length },
    'Wikipedia beats stored for film'
  )

  return { status: 'generated', beatCount: beats.length }
}

export type { StoryBeat }
