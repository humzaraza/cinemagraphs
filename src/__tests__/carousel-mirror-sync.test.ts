import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@/generated/prisma/client'

const mocks = vi.hoisted(() => ({
  prisma: {
    carouselDraft: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
  renderMiddleSlide: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/carousel/render-middle-slide', () => ({
  renderMiddleSlide: mocks.renderMiddleSlide,
}))

import { applyMirrorSync } from '@/lib/carousel/mirror-sync'

const PRIMARY_ID = 'draft-primary'
const MIRROR_ID = 'draft-mirror'
const FILM_ID = 'film-1'

type SlotShape = {
  position: number
  kind: string
  originalRole: string | null
  beatTimestamp: number | null
  beatScore: number | null
  timestampLabel: string
  collision: boolean
}

function slot(
  position: number,
  t: number,
  score: number,
  label: string,
): SlotShape {
  return {
    position,
    kind: 'middle',
    originalRole: 'drop',
    beatTimestamp: t,
    beatScore: score,
    timestampLabel: label,
    collision: false,
  }
}

// Six distinct timestamps across the middle slots (2-7). slot 4's and slot 6's
// are used by the collision-recompute test: setting slot 4's beat to 100
// creates a two-way conflict with slot 6.
const BASE_SLOTS: SlotShape[] = [
  slot(2, 5, 7.5, '5m'),
  slot(3, 25, 6.0, '25m'),
  slot(4, 50, 4.0, '50m'),
  slot(5, 75, 6.5, '1h 15m'),
  slot(6, 100, 9.2, '1h 40m'),
  slot(7, 150, 7.0, '2h 30m'),
]

type CopyShape = {
  pill: string
  headline: string
  body: string
  manuallyEdited?: boolean
}

function makeCopy(
  overrides: Partial<CopyShape> = {},
): CopyShape {
  return { pill: 'PILL', headline: 'Head.', body: 'Body.', ...overrides }
}

const BASE_BODY: Record<string, CopyShape> = {
  '2': makeCopy(),
  '3': makeCopy(),
  '4': makeCopy(),
  '5': makeCopy(),
  '6': makeCopy(),
  '7': makeCopy(),
}

// Shape returned by the primary findUnique. Only selects the fields
// applyMirrorSync actually reads — matches the `select` block in the module.
function defaultPrimary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    bodyCopyJson: BASE_BODY,
    aiBodyCopyJson: BASE_BODY,
    slotSelectionsJson: BASE_SLOTS,
    aiSlotSelectionsJson: BASE_SLOTS,
    characteristicsJson: { tone: 'neutral' },
    backdropUrl: 'https://example.com/bg.jpg',
    slideBackdropsJson: null as Record<string, string> | null,
    generatedAtModel: 'claude-opus-4-7',
    staleBodyCopySlots: [] as number[],
    mirrorSyncStatus: null as string | null,
    ...overrides,
  }
}

// Shape returned by the mirror upsert — full row (upsert returns the model).
function defaultMirrorRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: MIRROR_ID,
    filmId: FILM_ID,
    format: '9x16',
    bodyCopyJson: BASE_BODY,
    aiBodyCopyJson: BASE_BODY,
    slotSelectionsJson: BASE_SLOTS,
    aiSlotSelectionsJson: BASE_SLOTS,
    characteristicsJson: { tone: 'neutral' },
    backdropUrl: 'https://example.com/bg.jpg',
    slideBackdropsJson: null as Record<string, string> | null,
    generatedAtModel: 'claude-opus-4-7',
    staleBodyCopySlots: [] as number[],
    mirrorSyncStatus: null as string | null,
    mirrorSyncError: null as string | null,
    mirrorRenderedAt: null as Date | null,
    generatedAt: new Date('2026-01-01'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('applyMirrorSync — bodyCopy edit', () => {
  it('propagates the new copy to mirror, preserving manuallyEdited', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(defaultMirrorRow())
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    const newCopy: CopyShape = {
      pill: 'NEW',
      headline: 'New headline.',
      body: 'New body.',
      manuallyEdited: true,
    }

    const result = await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'bodyCopy', slideNum: 3, copy: newCopy },
    })

    // Exactly one update call: mirror. No primary-clear because primary's
    // mirrorSyncStatus was null (nothing to clear).
    const updateCalls = mocks.prisma.carouselDraft.update.mock.calls
    expect(updateCalls).toHaveLength(1)
    const arg = updateCalls[0][0] as {
      where: { id: string }
      data: Record<string, unknown>
    }
    expect(arg.where).toEqual({ id: MIRROR_ID })
    expect(arg.data).toMatchObject({
      mirrorSyncStatus: 'synced',
      mirrorSyncError: null,
    })
    // slotSelections and staleBodyCopySlots must NOT be in a bodyCopy-edit update.
    expect(arg.data.slotSelectionsJson).toBeUndefined()
    expect(arg.data.staleBodyCopySlots).toBeUndefined()

    const nextBody = arg.data.bodyCopyJson as Record<string, CopyShape>
    expect(nextBody['3']).toEqual(newCopy)
    expect(nextBody['3'].manuallyEdited).toBe(true)
    expect(nextBody['2']).toEqual(BASE_BODY['2'])
    expect(nextBody['4']).toEqual(BASE_BODY['4'])

    expect(result).toEqual({
      status: 'synced',
      mirrorDraftId: MIRROR_ID,
      staleBodyCopySlotsAdded: [],
    })
  })
})

describe('applyMirrorSync — beat edit', () => {
  it('recomputes collision on both slots when the new beat collides with another slot', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(defaultMirrorRow())
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    // Mirror slot 4 starts at t=50; change to t=100 which already belongs
    // to slot 6 → buildConflictMap should flip collision=true on both.
    const result = await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: {
        kind: 'beat',
        slideNum: 4,
        beatTimestamp: 100,
        beatScore: 9.2,
        timestampLabel: '1h 40m',
      },
    })

    const updateCalls = mocks.prisma.carouselDraft.update.mock.calls
    expect(updateCalls).toHaveLength(1)
    const arg = updateCalls[0][0] as {
      where: { id: string }
      data: Record<string, unknown>
    }
    expect(arg.where).toEqual({ id: MIRROR_ID })
    expect(arg.data).toMatchObject({
      mirrorSyncStatus: 'synced',
      mirrorSyncError: null,
    })
    // bodyCopy is NOT touched on a beat-only edit.
    expect(arg.data.bodyCopyJson).toBeUndefined()

    const nextSlots = arg.data.slotSelectionsJson as SlotShape[]
    const s2 = nextSlots.find((s) => s.position === 2)!
    const s4 = nextSlots.find((s) => s.position === 4)!
    const s6 = nextSlots.find((s) => s.position === 6)!
    expect(s4.beatTimestamp).toBe(100)
    expect(s4.beatScore).toBe(9.2)
    expect(s4.timestampLabel).toBe('1h 40m')
    expect(s4.collision).toBe(true)
    expect(s6.collision).toBe(true)
    expect(s2.collision).toBe(false)

    // Mirror's bodyCopy[4] was auto-generated (no manuallyEdited flag) →
    // stale detection should NOT add a flag.
    expect(arg.data.staleBodyCopySlots).toBeUndefined()
    expect(result.staleBodyCopySlotsAdded).toEqual([])
  })

  it('flags the slide as stale when the mirror has a manually-edited body copy for it', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    const mirrorRow = defaultMirrorRow({
      bodyCopyJson: {
        ...BASE_BODY,
        '4': makeCopy({ manuallyEdited: true }),
      },
      staleBodyCopySlots: [],
    })
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(mirrorRow)
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    const result = await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: {
        kind: 'beat',
        slideNum: 4,
        beatTimestamp: 80,
        beatScore: 5.0,
        timestampLabel: '1h 20m',
      },
    })

    const updateCalls = mocks.prisma.carouselDraft.update.mock.calls
    expect(updateCalls).toHaveLength(1)
    const arg = updateCalls[0][0] as {
      where: { id: string }
      data: Record<string, unknown>
    }
    expect(arg.data.staleBodyCopySlots).toEqual([4])
    expect(result).toEqual({
      status: 'synced',
      mirrorDraftId: MIRROR_ID,
      staleBodyCopySlotsAdded: [4],
    })
  })

  it('does NOT flag stale when the mirror body copy is auto-generated (manuallyEdited falsy)', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    const mirrorRow = defaultMirrorRow({
      bodyCopyJson: {
        ...BASE_BODY,
        '4': makeCopy({ manuallyEdited: false }),
      },
      staleBodyCopySlots: [],
    })
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(mirrorRow)
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    const result = await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: {
        kind: 'beat',
        slideNum: 4,
        beatTimestamp: 80,
        beatScore: 5.0,
        timestampLabel: '1h 20m',
      },
    })

    const arg = mocks.prisma.carouselDraft.update.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(arg.data.staleBodyCopySlots).toBeUndefined()
    expect(result.staleBodyCopySlotsAdded).toEqual([])
  })
})

describe('applyMirrorSync — mirror auto-create', () => {
  it('inherits baselines from primary in the upsert create arg, no generatedAt', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(defaultMirrorRow())
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'bodyCopy', slideNum: 3, copy: makeCopy() },
    })

    expect(mocks.prisma.carouselDraft.upsert).toHaveBeenCalledTimes(1)
    const upsertArg = mocks.prisma.carouselDraft.upsert.mock.calls[0][0] as {
      where: { filmId_format: { filmId: string; format: string } }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }
    expect(upsertArg.where).toEqual({
      filmId_format: { filmId: FILM_ID, format: '9x16' },
    })
    expect(upsertArg.create).toEqual(
      expect.objectContaining({
        filmId: FILM_ID,
        format: '9x16',
        bodyCopyJson: BASE_BODY,
        slotSelectionsJson: BASE_SLOTS,
        aiBodyCopyJson: BASE_BODY,
        aiSlotSelectionsJson: BASE_SLOTS,
        characteristicsJson: { tone: 'neutral' },
        backdropUrl: 'https://example.com/bg.jpg',
        generatedAtModel: 'claude-opus-4-7',
        mirrorSyncStatus: null,
        mirrorSyncError: null,
        mirrorRenderedAt: null,
        staleBodyCopySlots: [],
      }),
    )
    // generatedAt is intentionally omitted so the schema's @default(now()) fires.
    expect(upsertArg.create).not.toHaveProperty('generatedAt')
    // update branch is a no-op — real data changes go through the follow-up update.
    expect(upsertArg.update).toEqual({})
  })

  it('omits nullable baselines from create when primary has them as null', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(
      defaultPrimary({
        aiBodyCopyJson: null,
        aiSlotSelectionsJson: null,
      }),
    )
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(
      defaultMirrorRow({ aiBodyCopyJson: null, aiSlotSelectionsJson: null }),
    )
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'bodyCopy', slideNum: 3, copy: makeCopy() },
    })

    const upsertArg = mocks.prisma.carouselDraft.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>
    }
    // Conditional spread should have omitted the null fields so Prisma
    // doesn't need the JsonNull/DbNull sentinels.
    expect(upsertArg.create).not.toHaveProperty('aiBodyCopyJson')
    expect(upsertArg.create).not.toHaveProperty('aiSlotSelectionsJson')
    // Non-null required fields are still present.
    expect(upsertArg.create).toHaveProperty('bodyCopyJson')
    expect(upsertArg.create).toHaveProperty('slotSelectionsJson')
  })
})

describe('applyMirrorSync — failure handling', () => {
  it('records failure on the primary row and returns failed status when the mirror update throws', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(defaultMirrorRow())
    // First update (mirror) throws; second update (primary failure-record) succeeds.
    mocks.prisma.carouselDraft.update
      .mockRejectedValueOnce(new Error('db exploded'))
      .mockResolvedValueOnce({})

    const result = await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'bodyCopy', slideNum: 3, copy: makeCopy() },
    })

    // Must not throw — caller relies on the returned result shape.
    expect(result).toEqual({ status: 'failed', error: 'db exploded' })

    const updateCalls = mocks.prisma.carouselDraft.update.mock.calls
    expect(updateCalls).toHaveLength(2)
    // First attempt: mirror update.
    expect((updateCalls[0][0] as { where: { id: string } }).where).toEqual({
      id: MIRROR_ID,
    })
    // Second call: primary failure-record.
    expect(updateCalls[1][0]).toEqual({
      where: { id: PRIMARY_ID },
      data: {
        mirrorSyncStatus: 'failed',
        mirrorSyncError: 'db exploded',
      },
    })
  })
})

describe('applyMirrorSync — primary failure state', () => {
  it('clears mirrorSyncStatus on primary when it was previously failed', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(
      defaultPrimary({ mirrorSyncStatus: 'failed' }),
    )
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(defaultMirrorRow())
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'bodyCopy', slideNum: 3, copy: makeCopy() },
    })

    const updateCalls = mocks.prisma.carouselDraft.update.mock.calls
    // First call = mirror update. Second call = primary clear.
    expect(updateCalls).toHaveLength(2)
    expect((updateCalls[0][0] as { where: { id: string } }).where).toEqual({
      id: MIRROR_ID,
    })
    expect(updateCalls[1][0]).toEqual({
      where: { id: PRIMARY_ID },
      data: {
        mirrorSyncStatus: 'synced',
        mirrorSyncError: null,
      },
    })
  })

  it('does NOT write to primary on the happy path when mirrorSyncStatus was null', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(
      defaultPrimary({ mirrorSyncStatus: null }),
    )
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(defaultMirrorRow())
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'bodyCopy', slideNum: 3, copy: makeCopy() },
    })

    const updateCalls = mocks.prisma.carouselDraft.update.mock.calls
    // Only the mirror update, no follow-up on the primary.
    expect(updateCalls).toHaveLength(1)
    expect((updateCalls[0][0] as { where: { id: string } }).where).toEqual({
      id: MIRROR_ID,
    })
  })
})

describe('applyMirrorSync — still kind', () => {
  it('propagates a new still to the mirror when mirror has no existing map', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(
      defaultPrimary({ slideBackdropsJson: { '3': 'https://image.tmdb.org/t/p/w1280/a.jpg' } }),
    )
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(
      defaultMirrorRow({ slideBackdropsJson: null }),
    )
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    const result = await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'still', slideNum: 3, stillUrl: 'https://image.tmdb.org/t/p/w1280/a.jpg' },
    })

    const arg = mocks.prisma.carouselDraft.update.mock.calls[0][0] as {
      where: { id: string }
      data: Record<string, unknown>
    }
    expect(arg.where).toEqual({ id: MIRROR_ID })
    expect(arg.data.slideBackdropsJson).toEqual({ '3': 'https://image.tmdb.org/t/p/w1280/a.jpg' })
    // bodyCopy and slotSelections must NOT be touched on a still edit.
    expect(arg.data.bodyCopyJson).toBeUndefined()
    expect(arg.data.slotSelectionsJson).toBeUndefined()
    expect(result).toEqual({
      status: 'synced',
      mirrorDraftId: MIRROR_ID,
      staleBodyCopySlotsAdded: [],
    })
  })

  it('merges new still into existing mirror map without clobbering other slides', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(
      defaultMirrorRow({
        slideBackdropsJson: { '2': 'https://image.tmdb.org/t/p/w1280/x.jpg' },
      }),
    )
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'still', slideNum: 4, stillUrl: 'https://image.tmdb.org/t/p/w1280/y.jpg' },
    })

    const arg = mocks.prisma.carouselDraft.update.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(arg.data.slideBackdropsJson).toEqual({
      '2': 'https://image.tmdb.org/t/p/w1280/x.jpg',
      '4': 'https://image.tmdb.org/t/p/w1280/y.jpg',
    })
  })

  it('clearing a still (stillUrl: null) removes only that key', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(
      defaultMirrorRow({
        slideBackdropsJson: {
          '3': 'https://image.tmdb.org/t/p/w1280/a.jpg',
          '5': 'https://image.tmdb.org/t/p/w1280/b.jpg',
        },
      }),
    )
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'still', slideNum: 3, stillUrl: null },
    })

    const arg = mocks.prisma.carouselDraft.update.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(arg.data.slideBackdropsJson).toEqual({
      '5': 'https://image.tmdb.org/t/p/w1280/b.jpg',
    })
  })

  it('clearing the last still nulls the whole column (Prisma.DbNull, not {})', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(
      defaultMirrorRow({
        slideBackdropsJson: { '3': 'https://image.tmdb.org/t/p/w1280/a.jpg' },
      }),
    )
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'still', slideNum: 3, stillUrl: null },
    })

    const arg = mocks.prisma.carouselDraft.update.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(arg.data.slideBackdropsJson).toBe(Prisma.DbNull)
    expect(arg.data.slideBackdropsJson).not.toEqual({})
  })

  it('does not mark body copy stale for still edits even when mirror has manuallyEdited copy', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(
      defaultMirrorRow({
        bodyCopyJson: { ...BASE_BODY, '3': makeCopy({ manuallyEdited: true }) },
        staleBodyCopySlots: [] as number[],
      }),
    )
    mocks.prisma.carouselDraft.update.mockResolvedValue({})

    const result = await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'still', slideNum: 3, stillUrl: 'https://image.tmdb.org/t/p/w1280/a.jpg' },
    })

    const arg = mocks.prisma.carouselDraft.update.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(arg.data.staleBodyCopySlots).toBeUndefined()
    expect(result.staleBodyCopySlotsAdded).toEqual([])
  })

  it('failure path writes mirrorSyncError on primary for a still edit', async () => {
    mocks.prisma.carouselDraft.findUnique.mockResolvedValue(defaultPrimary())
    mocks.prisma.carouselDraft.upsert.mockResolvedValue(defaultMirrorRow())
    mocks.prisma.carouselDraft.update
      .mockRejectedValueOnce(new Error('still db error'))
      .mockResolvedValueOnce({})

    const result = await applyMirrorSync({
      primaryDraftId: PRIMARY_ID,
      primaryFilmId: FILM_ID,
      primaryFormat: '4x5',
      edit: { kind: 'still', slideNum: 3, stillUrl: 'https://image.tmdb.org/t/p/w1280/a.jpg' },
    })

    expect(result).toEqual({ status: 'failed', error: 'still db error' })
    const updateCalls = mocks.prisma.carouselDraft.update.mock.calls
    expect(updateCalls).toHaveLength(2)
    expect(updateCalls[1][0]).toEqual({
      where: { id: PRIMARY_ID },
      data: { mirrorSyncStatus: 'failed', mirrorSyncError: 'still db error' },
    })
  })
})
