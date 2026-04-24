// Per-slot beat-collision helpers for the admin beat-picker UI.
//
// "Conflict" here means two or more middle slots (positions 2-7) reference
// the same beat (same beatTimestamp). This is computed dynamically — the
// `collision` flag persisted by selectBeatSlots only reflects the algorithm's
// initial output; once admin starts editing slots, conflicts can come and go.
//
// The endpoints use this in two ways:
//   1. conflictsForSlot — slots OTHER than the one just edited that share its
//      new beatTimestamp. Returned in PATCH/Reset responses so the UI can
//      render a per-slot warning badge.
//   2. recomputeCollisionFlags — fresh per-slot collision booleans for the
//      whole middle range (2-7), written back into slotSelectionsJson before
//      persistence so the persisted field stays in sync with reality.

export type SlotForConflictCheck = {
  position: number
  beatTimestamp: number | null
}

const MIDDLE_RANGE = { min: 2, max: 7 } as const

function isMiddle(s: SlotForConflictCheck): boolean {
  return s.position >= MIDDLE_RANGE.min && s.position <= MIDDLE_RANGE.max
}

// Other middle slots that share the queried slot's beatTimestamp. Excludes
// the queried slot itself. Returns slot positions in ascending order. If the
// queried slot has no beat, returns an empty array.
export function conflictsForSlot(
  slots: SlotForConflictCheck[],
  slidePosition: number,
): number[] {
  const queried = slots.find((s) => s.position === slidePosition)
  if (!queried || queried.beatTimestamp === null) return []
  const out: number[] = []
  for (const s of slots) {
    if (!isMiddle(s)) continue
    if (s.position === slidePosition) continue
    if (s.beatTimestamp === null) continue
    if (s.beatTimestamp === queried.beatTimestamp) out.push(s.position)
  }
  return out.sort((a, b) => a - b)
}

// Map of every middle slot position → array of OTHER middle positions that
// share its beatTimestamp. Empty array means no conflict for that slot.
// Iterating: { 2: [], 3: [5], 4: [], 5: [3], 6: [], 7: [] }.
export function buildConflictMap(
  slots: SlotForConflictCheck[],
): Record<number, number[]> {
  const out: Record<number, number[]> = {}
  for (const s of slots) {
    if (!isMiddle(s)) continue
    out[s.position] = conflictsForSlot(slots, s.position)
  }
  return out
}

// Returns true if the given slot's beatTimestamp is shared with any other
// middle slot. Used to populate the persisted `collision` flag.
export function hasConflict(
  slots: SlotForConflictCheck[],
  slidePosition: number,
): boolean {
  return conflictsForSlot(slots, slidePosition).length > 0
}
