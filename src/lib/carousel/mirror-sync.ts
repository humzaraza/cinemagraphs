import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { renderMiddleSlide } from './render-middle-slide'
import { buildConflictMap, type SlotForConflictCheck } from './slot-conflicts'
import {
  isManuallyEdited,
  type MiddleSlideNumber,
  type SlideCopy,
} from './body-copy-generator'

type Format = '4x5' | '9x16'

// Mirrors the StoredSlot shape used by the beat PATCH route. Kept local so
// this module doesn't reach into a route file.
type StoredSlot = {
  position: number
  kind: string
  originalRole: string | null
  beatTimestamp: number | null
  beatScore: number | null
  timestampLabel: string
  collision: boolean
  duplicateTimestamp?: boolean
}

export type MirrorEditKind =
  | { kind: 'bodyCopy'; slideNum: MiddleSlideNumber; copy: SlideCopy }
  | {
      kind: 'beat'
      slideNum: MiddleSlideNumber
      beatTimestamp: number
      beatScore: number
      timestampLabel: string
    }
  | {
      kind: 'still'
      slideNum: MiddleSlideNumber
      stillUrl: string | null
    }

export type MirrorSyncResult = {
  status: 'synced' | 'failed' | 'skipped'
  error?: string
  mirrorDraftId?: string
  staleBodyCopySlotsAdded?: number[]
}

function oppositeFormat(f: Format): Format {
  return f === '4x5' ? '9x16' : '4x5'
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n)
}

// Apply an edit from the primary draft to its opposite-format mirror. Creates
// the mirror row on demand (inheriting baselines from primary) and writes the
// single field that changed. Never throws — failures are recorded on the
// primary row via mirrorSyncStatus/mirrorSyncError so the UI can surface them.
export async function applyMirrorSync(args: {
  primaryDraftId: string
  primaryFilmId: string
  primaryFormat: Format
  edit: MirrorEditKind
}): Promise<MirrorSyncResult> {
  const { primaryDraftId, primaryFilmId, primaryFormat, edit } = args
  const mirrorFormat = oppositeFormat(primaryFormat)

  const primary = await prisma.carouselDraft.findUnique({
    where: { id: primaryDraftId },
    select: {
      bodyCopyJson: true,
      aiBodyCopyJson: true,
      slotSelectionsJson: true,
      aiSlotSelectionsJson: true,
      characteristicsJson: true,
      backdropUrl: true,
      slideBackdropsJson: true,
      generatedAtModel: true,
      staleBodyCopySlots: true,
      mirrorSyncStatus: true,
    },
  })
  if (!primary) {
    return { status: 'failed', error: 'primary draft not found' }
  }

  try {
    // Upsert in a single call to avoid a TOCTOU race: without this, two tabs
    // editing opposite formats at the same time could both observe "no mirror
    // exists" via findUnique and both proceed to create, colliding on the
    // (filmId, format) unique index. Upsert lets Postgres handle the race.
    //
    // The create branch inherits baselines from primary verbatim so the
    // mirror starts out as an exact content clone. The update branch is a
    // no-op because the real edit is written in a separate `update` call
    // below — that lets us compute collision flags and staleness against the
    // post-upsert row state in a single write.
    const mirror = await prisma.carouselDraft.upsert({
      where: { filmId_format: { filmId: primaryFilmId, format: mirrorFormat } },
      create: {
        filmId: primaryFilmId,
        format: mirrorFormat,
        bodyCopyJson: primary.bodyCopyJson as unknown as object,
        slotSelectionsJson: primary.slotSelectionsJson as unknown as object,
        characteristicsJson: primary.characteristicsJson as unknown as object,
        // Nullable baselines: omit when primary's is null so the mirror ends
        // up with SQL NULL too (Prisma would otherwise require JsonNull/DbNull
        // sentinels to explicitly write null into a Json? field).
        ...(primary.aiBodyCopyJson !== null
          ? { aiBodyCopyJson: primary.aiBodyCopyJson as unknown as object }
          : {}),
        ...(primary.aiSlotSelectionsJson !== null
          ? { aiSlotSelectionsJson: primary.aiSlotSelectionsJson as unknown as object }
          : {}),
        ...(primary.slideBackdropsJson !== null
          ? { slideBackdropsJson: primary.slideBackdropsJson as unknown as object }
          : {}),
        backdropUrl: primary.backdropUrl,
        generatedAtModel: primary.generatedAtModel,
        mirrorSyncStatus: null,
        mirrorSyncError: null,
        mirrorRenderedAt: null,
        staleBodyCopySlots: [],
      },
      update: {},
    })

    const updateData: {
      bodyCopyJson?: object
      slotSelectionsJson?: object
      slideBackdropsJson?: object | typeof Prisma.DbNull
      staleBodyCopySlots?: number[]
      mirrorSyncStatus: string
      mirrorSyncError: null
    } = {
      mirrorSyncStatus: 'synced',
      mirrorSyncError: null,
    }

    let staleBodyCopySlotsAdded: number[] = []

    switch (edit.kind) {
      case 'bodyCopy': {
        const current = (mirror.bodyCopyJson ?? {}) as Record<string, SlideCopy>
        const next: Record<string, SlideCopy> = {
          ...current,
          [String(edit.slideNum)]: { ...edit.copy },
        }
        updateData.bodyCopyJson = next as unknown as object
        break
      }
      case 'beat': {
        const currentSlots = (Array.isArray(mirror.slotSelectionsJson)
          ? mirror.slotSelectionsJson
          : []) as unknown as StoredSlot[]
        const idx = currentSlots.findIndex((s) => s.position === edit.slideNum)
        if (idx === -1) {
          throw new Error(
            `mirror draft has no slot at position ${edit.slideNum}`,
          )
        }
        const nextSlot: StoredSlot = {
          ...currentSlots[idx],
          beatTimestamp: edit.beatTimestamp,
          beatScore: edit.beatScore,
          timestampLabel: edit.timestampLabel,
          collision: false, // recomputed below
        }
        const nextSlots: StoredSlot[] = currentSlots.map((s, i) =>
          i === idx ? nextSlot : s,
        )
        const conflictMap = buildConflictMap(nextSlots as SlotForConflictCheck[])
        const finalSlots: StoredSlot[] = nextSlots.map((s) => {
          if (s.position < 2 || s.position > 7) return s
          const conf = conflictMap[s.position] ?? []
          return { ...s, collision: conf.length > 0 }
        })
        updateData.slotSelectionsJson = finalSlots as unknown as object

        // Stale detection: a beat change on the primary invalidates the
        // mirror's slot alignment. If the mirror has a manually-edited body
        // copy for that slide, flag it so admin can see the copy may no longer
        // fit the new beat. Auto-generated copy rerenders cleanly via
        // fireAndForgetMirrorRender and doesn't need a flag.
        const mirrorCopy = (mirror.bodyCopyJson ?? {}) as Record<string, SlideCopy>
        const slotCopy = mirrorCopy[String(edit.slideNum)]
        if (slotCopy && isManuallyEdited(slotCopy)) {
          const existing = mirror.staleBodyCopySlots ?? []
          if (!existing.includes(edit.slideNum)) {
            const nextStale = [...existing, edit.slideNum].sort((a, b) => a - b)
            updateData.staleBodyCopySlots = nextStale
            staleBodyCopySlotsAdded = [edit.slideNum]
          }
        }
        break
      }
      case 'still': {
        const current = (mirror.slideBackdropsJson &&
        typeof mirror.slideBackdropsJson === 'object' &&
        !Array.isArray(mirror.slideBackdropsJson)
          ? mirror.slideBackdropsJson
          : {}) as Record<string, string>
        const next: Record<string, string> = { ...current }
        if (edit.stillUrl === null) {
          delete next[String(edit.slideNum)]
        } else {
          next[String(edit.slideNum)] = edit.stillUrl
        }
        updateData.slideBackdropsJson =
          Object.keys(next).length === 0 ? Prisma.DbNull : (next as unknown as object)
        break
      }
    }

    await prisma.carouselDraft.update({
      where: { id: mirror.id },
      data: updateData,
    })

    // Clear any previous failure state on the primary so the UI stops showing
    // a stale "mirror sync failed" banner once a later edit syncs cleanly.
    // Skipped on the happy path (no prior failure) to avoid a redundant write.
    if (primary.mirrorSyncStatus === 'failed') {
      await prisma.carouselDraft.update({
        where: { id: primaryDraftId },
        data: {
          mirrorSyncStatus: 'synced',
          mirrorSyncError: null,
        },
      })
    }

    return {
      status: 'synced',
      mirrorDraftId: mirror.id,
      staleBodyCopySlotsAdded,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      await prisma.carouselDraft.update({
        where: { id: primaryDraftId },
        data: {
          mirrorSyncStatus: 'failed',
          mirrorSyncError: truncate(message, 500),
        },
      })
    } catch {
      // If we can't even record the failure, give up quietly rather than
      // throwing from a sync path that's already failing.
    }
    return { status: 'failed', error: message }
  }
}

// Kick off a best-effort mirror re-render after a successful sync. Renders
// only the slide that changed, updates mirrorRenderedAt on success, and
// swallows all errors — staleness is implied by mirrorRenderedAt lagging
// behind updatedAt, so no explicit failure field is needed.
export function fireAndForgetMirrorRender(args: {
  mirrorDraftId: string
  slideNum: MiddleSlideNumber
}): void {
  void (async () => {
    try {
      await renderMiddleSlide({
        draftId: args.mirrorDraftId,
        slideNum: args.slideNum,
      })
      await prisma.carouselDraft.update({
        where: { id: args.mirrorDraftId },
        data: { mirrorRenderedAt: new Date() },
      })
    } catch (err) {
      console.error('[mirror-sync] fire-and-forget render failed', {
        mirrorDraftId: args.mirrorDraftId,
        slideNum: args.slideNum,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}
