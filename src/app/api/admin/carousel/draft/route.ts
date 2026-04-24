import { NextRequest } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { getMovieBackdropUrls } from '@/lib/tmdb'
import {
  generateBodyCopy,
  type SlideBeatContext,
  type SlideCopy,
  type MiddleSlideNumber,
} from '@/lib/carousel/body-copy-generator'
import { computeDotColor, type DataPoint } from '@/lib/carousel/graph-renderer'
import { composeSlide, type FilmData, type MiddleSlideContent } from '@/lib/carousel/slide-composer'
import {
  selectBeatSlots,
  formatTimestamp,
  type Beat,
  type BeatSlot,
  type OriginalRole,
  type SlotPosition,
} from '@/lib/carousel/slot-selection'
import type { SentimentDataPoint } from '@/lib/types'

export const dynamic = 'force-dynamic'

type Format = '4x5' | '9x16'

type SlotSelectionDTO = {
  position: number
  kind: string
  originalRole: string | null
  beatTimestamp: number | null
  beatScore: number | null
  timestampLabel: string
  collision: boolean
  duplicateTimestamp: boolean
}

const FORMAT_DIMS: Record<Format, { w: number; h: number }> = {
  '4x5': { w: 1080, h: 1350 },
  '9x16': { w: 1080, h: 1920 },
}

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

function toDataPoints(beats: Beat[]): DataPoint[] {
  return beats.map((b) => ({ t: b.timeMidpoint, s: b.score }))
}

function storyBeatNameFor(beat: Beat): string {
  return (beat.labelFull ?? beat.label ?? '').trim()
}

function runtimeLabel(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60)
    const m = minutes - h * 60
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `${minutes}m`
}

function middleSlotsWithBeats(slots: BeatSlot[]): Array<BeatSlot & { beat: Beat; originalRole: OriginalRole }> {
  const out: Array<BeatSlot & { beat: Beat; originalRole: OriginalRole }> = []
  for (const s of slots) {
    if (s.position < 2 || s.position > 7) continue
    if (!s.beat || !s.originalRole) {
      throw new Error(`Slot ${s.position} has no beat after selection — film data is insufficient.`)
    }
    out.push(s as BeatSlot & { beat: Beat; originalRole: OriginalRole })
  }
  return out
}

// Compose the rendered pill string: `{AI_PILL_OR_FALLBACK} · {TIMESTAMP}`,
// all uppercase. The AI already writes short mixed/sentence case; uppercasing
// happens here in the presentation layer.
function renderedPill(pillSource: string, timestampLabel: string): string {
  const pill = pillSource.trim()
  const ts = timestampLabel.trim().toUpperCase()
  if (!pill) return ts
  return `${pill.toUpperCase()} · ${ts}`
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

  let middleWithBeats: Array<BeatSlot & { beat: Beat; originalRole: OriginalRole }>
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

  let slideCopy: Record<MiddleSlideNumber, SlideCopy>
  let characteristics: unknown
  let generatedAtModel: string
  let generatedAt: Date
  let cached: boolean
  let draftId: string
  let backdropUrl: string | null
  // Effective slot selections for rendering + response. On cached path this is
  // the persisted state (so beat overrides survive reload); on fresh path it
  // mirrors the algorithm's pick. aiSlotSelections is the frozen baseline.
  let effectiveSlotSelections: SlotSelectionDTO[]
  let aiSlotSelectionsOut: SlotSelectionDTO[]

  let aiBodyCopyOut: Record<MiddleSlideNumber, SlideCopy>

  if (existing && !force) {
    slideCopy = existing.bodyCopyJson as unknown as Record<MiddleSlideNumber, SlideCopy>
    characteristics = existing.characteristicsJson
    generatedAtModel = existing.generatedAtModel
    generatedAt = existing.generatedAt
    cached = true
    draftId = existing.id
    backdropUrl = existing.backdropUrl
    // Lazy-resolve backdropUrl for rows that predate the column. After this
    // one-time fill, PATCH and revert read from the row without hitting TMDB.
    if (backdropUrl === null) {
      const urls = await getMovieBackdropUrls(film.tmdbId)
      backdropUrl = urls[0] ?? null
      await prisma.carouselDraft.update({
        where: { id: existing.id },
        data: { backdropUrl },
      })
    }
    // Backfill aiSlotSelectionsJson for rows that predate the column.
    if (existing.aiSlotSelectionsJson === null) {
      await prisma.carouselDraft.update({
        where: { id: existing.id },
        data: { aiSlotSelectionsJson: existing.slotSelectionsJson as unknown as object },
      })
    }
    // Backfill aiBodyCopyJson for rows that predate the column. Use the
    // current bodyCopy as the baseline — it's the best approximation of the
    // original AI output we have for pre-migration rows.
    if (existing.aiBodyCopyJson === null) {
      await prisma.carouselDraft.update({
        where: { id: existing.id },
        data: { aiBodyCopyJson: existing.bodyCopyJson as unknown as object },
      })
    }
    effectiveSlotSelections = (Array.isArray(existing.slotSelectionsJson)
      ? existing.slotSelectionsJson
      : []) as unknown as SlotSelectionDTO[]
    aiSlotSelectionsOut = (Array.isArray(existing.aiSlotSelectionsJson)
      ? existing.aiSlotSelectionsJson
      : effectiveSlotSelections) as unknown as SlotSelectionDTO[]
    aiBodyCopyOut = (existing.aiBodyCopyJson ?? existing.bodyCopyJson) as unknown as Record<
      MiddleSlideNumber,
      SlideCopy
    >
  } else {
    const slideContexts: SlideBeatContext[] = middleWithBeats.map((s) => ({
      slideNumber: s.position as MiddleSlideNumber,
      // Seed pill with the generic role label; the AI returns its own. Kept
      // on the context for compatibility with consumers that still read it.
      pillLabel: ROLE_PILL_FALLBACK[s.originalRole],
      beatTimestamp: s.beat.timeMidpoint,
      beatScore: s.beat.score,
      beatColor: computeDotColor(s.beat.score),
      originalRole: s.originalRole,
      storyBeatName: storyBeatNameFor(s.beat),
    }))

    const result = await generateBodyCopy({
      filmTitle: film.title,
      filmYear: year ?? new Date().getFullYear(),
      runtimeMinutes: film.runtime,
      criticsScore,
      dataPoints,
      slides: slideContexts,
    })

    slideCopy = { ...result.slideCopy }
    for (const n of [2, 3, 4, 5, 6, 7] as MiddleSlideNumber[]) {
      slideCopy[n] = { ...slideCopy[n], manuallyEdited: false }
    }
    characteristics = result.characteristics
    generatedAtModel = result.modelUsed

    const slotSelections: SlotSelectionDTO[] = slots.map((s) => ({
      position: s.position,
      kind: s.kind,
      originalRole: s.originalRole ?? null,
      beatTimestamp: s.beat?.timeMidpoint ?? null,
      beatScore: s.beat?.score ?? null,
      timestampLabel: s.timestampLabel,
      collision: s.collision,
      duplicateTimestamp: s.duplicateTimestamp ?? false,
    }))
    effectiveSlotSelections = slotSelections
    aiSlotSelectionsOut = slotSelections
    aiBodyCopyOut = slideCopy

    // Resolve backdrop URL on fresh generation and cache on the draft row so
    // subsequent PATCH / revert / cached POST don't re-hit TMDB.
    const freshBackdrops = await getMovieBackdropUrls(film.tmdbId)
    backdropUrl = freshBackdrops[0] ?? null

    const saved = await prisma.carouselDraft.upsert({
      where: { filmId_format: { filmId, format } },
      create: {
        filmId,
        format,
        bodyCopyJson: slideCopy as unknown as object,
        aiBodyCopyJson: slideCopy as unknown as object,
        slotSelectionsJson: slotSelections as unknown as object,
        aiSlotSelectionsJson: slotSelections as unknown as object,
        characteristicsJson: result.characteristics as unknown as object,
        backdropUrl,
        generatedAtModel,
      },
      update: {
        bodyCopyJson: slideCopy as unknown as object,
        aiBodyCopyJson: slideCopy as unknown as object,
        slotSelectionsJson: slotSelections as unknown as object,
        aiSlotSelectionsJson: slotSelections as unknown as object,
        characteristicsJson: result.characteristics as unknown as object,
        backdropUrl,
        generatedAt: new Date(),
        generatedAtModel,
      },
    })
    generatedAt = saved.generatedAt
    cached = false
    draftId = saved.id
  }

  // ── Render 8 slides ──────────────────────────────────────────
  const backgroundImage = backdropUrl ?? undefined

  const filmData: FilmData = {
    title: film.title,
    year: year ?? new Date().getFullYear(),
    runtime: runtimeLabel(film.runtime),
    genres: film.genres ?? [],
    criticsScore,
    dataPoints,
    totalRuntimeMinutes: film.runtime,
  }

  const beatIndexMap = new Map<number, number>()
  beats.forEach((b, i) => beatIndexMap.set(b.timeMidpoint, i))

  const dims = FORMAT_DIMS[format]

  const slideResults: Array<{ slideNumber: number; pngBase64: string; widthPx: number; heightPx: number }> = []
  for (const position of [1, 2, 3, 4, 5, 6, 7, 8] as SlotPosition[]) {
    let middleContent: MiddleSlideContent | undefined
    if (position >= 2 && position <= 7) {
      const persistedSlot = effectiveSlotSelections.find((s) => s.position === position)
      const beatTs = persistedSlot?.beatTimestamp
      // Fallback to fresh slot if persisted entry is somehow missing (e.g. an
      // older row with empty selectionsJson). This preserves backward compat
      // with the existing test fixtures that pass `slotSelectionsJson: []`.
      const freshSlot = slots.find((s) => s.position === position)
      const resolvedTs = beatTs ?? freshSlot?.beat?.timeMidpoint
      if (resolvedTs === undefined || resolvedTs === null) {
        return Response.json(
          { error: `Internal: could not resolve beat for slot ${position}` },
          { status: 500 },
        )
      }
      const beatIndex = beatIndexMap.get(resolvedTs)
      if (beatIndex === undefined) {
        return Response.json(
          { error: `Internal: could not locate beat for slot ${position}` },
          { status: 500 },
        )
      }
      const role = (persistedSlot?.originalRole ?? freshSlot?.originalRole ?? 'fallback') as OriginalRole
      const tsLabel = persistedSlot?.timestampLabel ?? freshSlot?.timestampLabel ?? formatTimestamp(resolvedTs)
      const slideNum = position as MiddleSlideNumber
      const copy = slideCopy[slideNum]
      const aiPill = copy?.pill ?? ''
      const pillSource = aiPill.trim() !== '' ? aiPill : ROLE_PILL_FALLBACK[role]
      // Prefer the AI-generated headline; fall back to the generic role
      // headline only if the AI output is missing or empty. The AI writes
      // short 3-6 word editorial framing tuned to each beat; the fallback
      // is a static per-role string that reads like filler by comparison.
      const aiHeadline = copy?.headline ?? ''
      const headlineSource =
        aiHeadline.trim() !== '' ? aiHeadline : ROLE_HEADLINE[role]
      middleContent = {
        pillLabel: renderedPill(pillSource, tsLabel),
        headline: headlineSource,
        bodyCopy: copy?.body ?? '',
        // dotPositions in graph-renderer are post-anchor; the anchor is at
        // index 0 so add 1 to reach the matching beat.
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

  void formatTimestamp // re-exported for tests; keep import alive

  // Stripped beat dictionary for the BeatPickerDropdown. Indexes are positions
  // in the chronologically-sorted beats array (the same one render-middle-slide
  // and the PATCH endpoint use). Title falls back to label when labelFull is
  // missing; color matches what the graph dots use.
  const availableBeats = beats.map((b, i) => ({
    beatIndex: i,
    title: (b.labelFull ?? b.label ?? '').trim(),
    timestamp: formatTimestamp(b.timeMidpoint),
    score: b.score,
    color: computeDotColor(b.score),
  }))

  return Response.json({
    draftId,
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
    // Raw body copy for slides 2-7, keyed by slide number as string. The
    // admin page uses this to hydrate editable textareas without having to
    // parse back out of the rendered PNGs.
    bodyCopy: slideCopy,
    // Frozen AI baseline body copy for slides 2-7. Used by Revert to decide
    // whether the current copy differs from the original AI output.
    aiBodyCopy: aiBodyCopyOut,
    // Persisted slot selections (current state — reflects beat overrides).
    slotSelections: effectiveSlotSelections,
    // Algorithm baseline, frozen at draft generation. Used by Reset.
    aiSlotSelections: aiSlotSelectionsOut,
    // Stripped beats for the dropdown UI. Indexed by position in the sorted array.
    availableBeats,
    slides: slideResults,
  })
}
