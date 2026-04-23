/**
 * One-off backfill: set `manuallyEdited: false` on existing CarouselDraft
 * bodyCopyJson slot entries that do not already have the field.
 *
 * Background: Phase C auto-sync adds an optional `manuallyEdited` flag to
 * SlideCopy to distinguish admin-edited copy from AI-generated baseline.
 * Pre-migration drafts were written without this field. Backfilling `false`
 * on every existing entry makes the downstream read contract explicit: any
 * persisted slot entry has the flag set, and `isManuallyEdited()` returns a
 * deterministic value without reading a `undefined`.
 *
 * Idempotent — a row is only written when at least one slot is missing the
 * flag, so a second run after a successful first run is a no-op.
 *
 * Usage: npx tsx scripts/backfill-manually-edited.ts
 */
import './_load-env'
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import type { SlideCopy } from '../src/lib/carousel/body-copy-generator'

const SLIDE_KEYS = ['2', '3', '4', '5', '6', '7'] as const

async function main() {
  const { prisma } = await import('../src/lib/prisma')

  const drafts = await prisma.carouselDraft.findMany({
    select: { id: true, format: true, bodyCopyJson: true },
    orderBy: { generatedAt: 'asc' },
  })

  console.log(`Loaded ${drafts.length} drafts`)

  let modified = 0
  let unchanged = 0

  for (const draft of drafts) {
    const bodyCopyJson = (draft.bodyCopyJson ?? {}) as unknown as Record<string, SlideCopy>
    const nextBodyCopy: Record<string, SlideCopy> = { ...bodyCopyJson }
    let slotsBackfilled = 0

    for (const key of SLIDE_KEYS) {
      const entry = nextBodyCopy[key]
      if (entry && entry.manuallyEdited === undefined) {
        nextBodyCopy[key] = { ...entry, manuallyEdited: false }
        slotsBackfilled++
      }
    }

    if (slotsBackfilled > 0) {
      await prisma.carouselDraft.update({
        where: { id: draft.id },
        data: { bodyCopyJson: nextBodyCopy as unknown as object },
      })
      console.log(`${draft.id} ${draft.format}: ${slotsBackfilled} slots backfilled`)
      modified++
    } else {
      console.log(`${draft.id} ${draft.format}: no-op`)
      unchanged++
    }
  }

  console.log(`Backfill complete. ${modified} drafts modified, ${unchanged} unchanged`)

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
