import { NextRequest } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { getMovieBackdropUrls } from '@/lib/tmdb'
import {
  generateBodyCopy,
  type SlideBeatContext,
  type MiddleSlideNumber,
} from '@/lib/carousel/body-copy-generator'
import { computeDotColor, type DataPoint } from '@/lib/carousel/graph-renderer'
import { composeSlide, type FilmData, type MiddleSlideContent } from '@/lib/carousel/slide-composer'
import {
  selectBeatSlots,
  formatTimestamp,
  type Beat,
  type BeatSlot,
  type SlotKind,
  type SlotPosition,
} from '@/lib/carousel/slot-selection'
import type { SentimentDataPoint } from '@/lib/types'

export const dynamic = 'force-dynamic'

type Format = '4x5' | '9x16'

const FORMAT_DIMS: Record<Format, { w: number; h: number }> = {
  '4x5': { w: 1080, h: 1350 },
  '9x16': { w: 1080, h: 1920 },
}

const KIND_TO_PILL_PREFIX: Record<Exclude<SlotKind, 'hook' | 'takeaway'>, string> = {
  opening: 'THE OPENING',
  setup: 'THE SETUP',
  drop: 'THE DROP',
  recovery: 'RECOVERY',
  peak: 'THE PEAK',
  ending: 'THE ENDING',
}

const KIND_TO_HEADLINE: Record<Exclude<SlotKind, 'hook' | 'takeaway'>, string> = {
  opening: 'Where the story starts.',
  setup: 'The audience settles in.',
  drop: 'Then the floor drops out.',
  recovery: 'Then it finds its footing.',
  peak: "The film's highest moment.",
  ending: 'How it lands.',
}

function toDataPoints(beats: Beat[]): DataPoint[] {
  return beats.map((b) => ({ t: b.timeMidpoint, s: b.score }))
}

function defaultPillLabel(slot: BeatSlot): string {
  const kind = slot.kind as Exclude<SlotKind, 'hook' | 'takeaway'>
  const prefix = KIND_TO_PILL_PREFIX[kind]
  return `${prefix} · ${slot.timestampLabel.toUpperCase()}`
}

function defaultHeadline(slot: BeatSlot): string {
  return KIND_TO_HEADLINE[slot.kind as Exclude<SlotKind, 'hook' | 'takeaway'>]
}

function middleSlotsWithBeats(slots: BeatSlot[]): Array<BeatSlot & { beat: Beat }> {
  const middle = slots.filter((s): s is BeatSlot => s.position >= 2 && s.position <= 7)
  const withBeats: Array<BeatSlot & { beat: Beat }> = []
  for (const s of middle) {
    if (!s.beat) {
      throw new Error(`Slot ${s.position} (${s.kind}) has no beat — film data is insufficient.`)
    }
    withBeats.push(s as BeatSlot & { beat: Beat })
  }
  return withBeats
}

function runtimeLabel(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60)
    const m = minutes - h * 60
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `${minutes}m`
}

export async function POST(request: NextRequest) {
  const auth = await requireRole('ADMIN')
  if (!auth.authorized) return auth.errorResponse!

  let body: { filmId?: unknown; format?: unknown; force?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const filmId = typeof body.filmId === 'string' ? body.filmId : null
  const format = body.format === '4x5' || body.format === '9x16' ? body.format : null
  const force = body.force === true

  if (!filmId) {
    return Response.json({ error: 'filmId is required' }, { status: 400 })
  }
  if (!format) {
    return Response.json({ error: 'format must be "4x5" or "9x16"' }, { status: 400 })
  }

  const film = await prisma.film.findUnique({
    where: { id: filmId },
    select: {
      id: true,
      tmdbId: true,
      title: true,
      releaseDate: true,
      runtime: true,
      genres: true,
      sentimentGraph: {
        select: { overallScore: true, dataPoints: true },
      },
    },
  })

  if (!film) {
    return Response.json({ error: 'Film not found' }, { status: 404 })
  }
  if (!film.sentimentGraph) {
    return Response.json({ error: 'Film has no sentiment graph' }, { status: 400 })
  }
  if (!film.runtime || film.runtime <= 0) {
    return Response.json({ error: 'Film runtime is missing' }, { status: 400 })
  }

  const rawDataPoints = film.sentimentGraph.dataPoints
  const sentimentBeats = (Array.isArray(rawDataPoints) ? rawDataPoints : []) as unknown as SentimentDataPoint[]
  const beats: Beat[] = [...sentimentBeats].sort((a, b) => a.timeMidpoint - b.timeMidpoint)
  if (beats.length === 0) {
    return Response.json({ error: 'Film sentiment graph has no beats' }, { status: 400 })
  }

  const slots = selectBeatSlots(beats, film.runtime)

  let middleWithBeats: Array<BeatSlot & { beat: Beat }>
  try {
    middleWithBeats = middleSlotsWithBeats(slots)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Slot selection incomplete'
    return Response.json({ error: msg }, { status: 400 })
  }

  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : null
  const criticsScore = film.sentimentGraph.overallScore
  const dataPoints = toDataPoints(beats)

  // ── Cache lookup ─────────────────────────────────────────────
  const existing = await prisma.carouselDraft.findUnique({
    where: { filmId_format: { filmId, format } },
  })

  let bodyCopy: Record<MiddleSlideNumber, string>
  let characteristics: unknown
  let generatedAtModel: string
  let generatedAt: Date
  let cached: boolean

  if (existing && !force) {
    bodyCopy = existing.bodyCopyJson as unknown as Record<MiddleSlideNumber, string>
    characteristics = existing.characteristicsJson
    generatedAtModel = existing.generatedAtModel
    generatedAt = existing.generatedAt
    cached = true
  } else {
    const slideContexts: SlideBeatContext[] = middleWithBeats.map((s) => ({
      slideNumber: s.position as MiddleSlideNumber,
      pillLabel: defaultPillLabel(s),
      beatTimestamp: s.beat.timeMidpoint,
      beatScore: s.beat.score,
      beatColor: computeDotColor(s.beat.score),
    }))

    const result = await generateBodyCopy({
      filmTitle: film.title,
      filmYear: year ?? new Date().getFullYear(),
      runtimeMinutes: film.runtime,
      criticsScore,
      dataPoints,
      slides: slideContexts,
    })

    bodyCopy = result.bodyCopy
    characteristics = result.characteristics
    generatedAtModel = result.modelUsed

    const slotSelections = slots.map((s) => ({
      position: s.position,
      kind: s.kind,
      beatTimestamp: s.beat?.timeMidpoint ?? null,
      beatScore: s.beat?.score ?? null,
      timestampLabel: s.timestampLabel,
      collision: s.collision,
    }))

    const saved = await prisma.carouselDraft.upsert({
      where: { filmId_format: { filmId, format } },
      create: {
        filmId,
        format,
        bodyCopyJson: bodyCopy as unknown as object,
        slotSelectionsJson: slotSelections as unknown as object,
        characteristicsJson: result.characteristics as unknown as object,
        generatedAtModel,
      },
      update: {
        bodyCopyJson: bodyCopy as unknown as object,
        slotSelectionsJson: slotSelections as unknown as object,
        characteristicsJson: result.characteristics as unknown as object,
        generatedAt: new Date(),
        generatedAtModel,
      },
    })
    generatedAt = saved.generatedAt
    cached = false
  }

  // ── Render 8 slides ──────────────────────────────────────────
  // TODO C5: replace the single backdrop with per-slide TMDB stills. Each of
  // the 8 slides should pull a distinct, contextually-relevant image from
  // TMDB (opening still for slide 2, drop still for slide 4, peak still
  // for slide 6, etc.) rather than reusing the same blurred backdrop.
  const backdrops = await getMovieBackdropUrls(film.tmdbId)
  const backgroundImage = backdrops.length > 0 ? backdrops[0] : undefined

  const filmData: FilmData = {
    title: film.title,
    year: year ?? new Date().getFullYear(),
    runtime: runtimeLabel(film.runtime),
    genres: film.genres ?? [],
    criticsScore,
    dataPoints,
    totalRuntimeMinutes: film.runtime,
  }

  const beatIndexMap = new Map<Beat, number>()
  beats.forEach((b, i) => beatIndexMap.set(b, i))

  const dims = FORMAT_DIMS[format]

  const slideResults: Array<{ slideNumber: number; pngBase64: string; widthPx: number; heightPx: number }> = []
  for (const position of [1, 2, 3, 4, 5, 6, 7, 8] as SlotPosition[]) {
    let middleContent: MiddleSlideContent | undefined
    if (position >= 2 && position <= 7) {
      const slot = slots.find((s) => s.position === position)!
      const beat = slot.beat!
      const beatIndex = beatIndexMap.get(beat)
      if (beatIndex === undefined) {
        return Response.json(
          { error: `Internal: could not locate beat for slot ${position}` },
          { status: 500 },
        )
      }
      const slideNum = position as MiddleSlideNumber
      middleContent = {
        pillLabel: defaultPillLabel(slot),
        headline: defaultHeadline(slot),
        bodyCopy: bodyCopy[slideNum] ?? '',
        highlightBeatIndex: beatIndex + 1,
      }
    }

    const png = await composeSlide({
      film: filmData,
      slideNumber: position,
      format,
      middleContent,
      backgroundImage,
    })

    slideResults.push({
      slideNumber: position,
      pngBase64: png.toString('base64'),
      widthPx: dims.w,
      heightPx: dims.h,
    })
  }

  return Response.json({
    film: {
      id: film.id,
      title: film.title,
      year,
      runtimeMinutes: film.runtime,
      genres: film.genres ?? [],
      criticsScore,
    },
    format,
    cached,
    generatedAt: generatedAt.toISOString(),
    generatedAtModel,
    characteristics,
    slides: slideResults,
  })
}
