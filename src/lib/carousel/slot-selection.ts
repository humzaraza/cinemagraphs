import type { SentimentDataPoint } from '@/lib/types'

export type Beat = SentimentDataPoint

export type SlotKind =
  | 'hook'
  | 'opening'
  | 'setup'
  | 'drop'
  | 'recovery'
  | 'peak'
  | 'ending'
  | 'takeaway'

export type SlotPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface BeatSlot {
  position: SlotPosition
  kind: SlotKind
  beat: Beat | null
  timestampLabel: string
  collision: boolean
  // Set when dedup fails to find a distinct alternative for this slot and
  // the original (colliding) beat is kept. Phase C4's admin UI surfaces this
  // as a warning so the editor knows two slides share a timestamp.
  duplicateTimestamp?: boolean
}

export function formatTimestamp(minutes: number): string {
  const total = Math.round(minutes)
  if (total >= 60) {
    const h = Math.floor(total / 60)
    const m = total - h * 60
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `${Math.max(0, total)}m`
}

function makeSlot(position: SlotPosition, kind: SlotKind, beat: Beat | null): BeatSlot {
  return {
    position,
    kind,
    beat,
    timestampLabel: beat ? formatTimestamp(beat.timeMidpoint) : '',
    collision: false,
  }
}

// ── Deduplication pass ────────────────────────────────────────
// Walks middle slots (2-7) in order. If a slot's beat timestamp is already
// taken by an earlier-processed slot, try a per-kind alternative that isn't
// assigned. On failure, keep the original beat and set duplicateTimestamp.

function findAlternativeBeat(
  slot: BeatSlot,
  beats: Beat[],
  runtimeMinutes: number,
  assigned: Set<number>,
  currentDropBeat: Beat | null,
): Beat | null {
  switch (slot.kind) {
    case 'opening': {
      const max = runtimeMinutes * 0.1
      return (
        beats
          .filter((b) => b.timeMidpoint <= max && !assigned.has(b.timeMidpoint))
          .sort((a, b) => a.timeMidpoint - b.timeMidpoint)[0] ?? null
      )
    }
    case 'setup': {
      const min = runtimeMinutes * 0.1
      const max = runtimeMinutes * 0.4
      return (
        beats
          .filter(
            (b) =>
              b.timeMidpoint >= min &&
              b.timeMidpoint < max &&
              !assigned.has(b.timeMidpoint),
          )
          .sort((a, b) => b.score - a.score || a.timeMidpoint - b.timeMidpoint)[0] ?? null
      )
    }
    case 'drop': {
      const sorted = [...beats].sort(
        (a, b) => a.score - b.score || a.timeMidpoint - b.timeMidpoint,
      )
      for (const b of sorted) {
        if (!assigned.has(b.timeMidpoint)) return b
      }
      return null
    }
    case 'recovery': {
      if (!currentDropBeat) return null
      const dropScore = currentDropBeat.score
      const dropTime = currentDropBeat.timeMidpoint
      const afterDrop = beats.filter((b) => b.timeMidpoint > dropTime)
      for (const b of afterDrop) {
        if (b.score - dropScore >= 1.0 && !assigned.has(b.timeMidpoint)) return b
      }
      for (const b of afterDrop) {
        if (b.score > dropScore && !assigned.has(b.timeMidpoint)) return b
      }
      return null
    }
    case 'peak': {
      const sorted = [...beats].sort(
        (a, b) => b.score - a.score || a.timeMidpoint - b.timeMidpoint,
      )
      for (const b of sorted) {
        if (!assigned.has(b.timeMidpoint)) return b
      }
      return null
    }
    case 'ending': {
      for (let i = beats.length - 1; i >= 0; i--) {
        if (!assigned.has(beats[i].timeMidpoint)) return beats[i]
      }
      return null
    }
    default:
      return null
  }
}

function dedupMiddleSlots(
  slots: BeatSlot[],
  beats: Beat[],
  runtimeMinutes: number,
): void {
  const assigned = new Set<number>()
  for (const slot of slots) {
    if (slot.position < 2 || slot.position > 7) continue
    if (!slot.beat) continue
    const ts = slot.beat.timeMidpoint
    if (!assigned.has(ts)) {
      assigned.add(ts)
      continue
    }
    const dropSlot = slots.find((s) => s.position === 4)
    const currentDropBeat = dropSlot?.beat ?? null
    const alt = findAlternativeBeat(slot, beats, runtimeMinutes, assigned, currentDropBeat)
    if (alt) {
      slot.beat = alt
      slot.timestampLabel = formatTimestamp(alt.timeMidpoint)
      assigned.add(alt.timeMidpoint)
    } else {
      slot.duplicateTimestamp = true
    }
  }
}

export function selectBeatSlots(beats: Beat[], runtimeMinutes: number): BeatSlot[] {
  const emptySlots: BeatSlot[] = [
    makeSlot(1, 'hook', null),
    makeSlot(2, 'opening', null),
    makeSlot(3, 'setup', null),
    makeSlot(4, 'drop', null),
    makeSlot(5, 'recovery', null),
    makeSlot(6, 'peak', null),
    makeSlot(7, 'ending', null),
    makeSlot(8, 'takeaway', null),
  ]

  if (beats.length === 0) {
    return emptySlots
  }

  const slot1 = makeSlot(1, 'hook', null)
  const slot8 = makeSlot(8, 'takeaway', null)

  // Slot 2: opening = first beat
  const slot2 = makeSlot(2, 'opening', beats[0])

  // Slot 3: setup = highest-scoring beat with timeMidpoint < runtime * 0.4,
  // excluding beats[0]. Ties → earliest. Fall back to beats[1] if no candidate.
  const setupThreshold = runtimeMinutes * 0.4
  let setupBeat: Beat | null = null
  for (let i = 1; i < beats.length; i++) {
    const b = beats[i]
    if (b.timeMidpoint < setupThreshold) {
      if (!setupBeat || b.score > setupBeat.score) {
        setupBeat = b
      }
    }
  }
  if (!setupBeat) {
    setupBeat = beats[1] ?? null
  }
  const slot3 = makeSlot(3, 'setup', setupBeat)

  // Slot 4: drop = lowest score overall. Ties → earliest.
  let dropIdx = 0
  for (let i = 1; i < beats.length; i++) {
    if (beats[i].score < beats[dropIdx].score) {
      dropIdx = i
    }
  }
  const slot4 = makeSlot(4, 'drop', beats[dropIdx])

  // Slot 5: recovery = first beat after slot4 with (score - slot4.score) >= 1.0.
  // If none, first beat after slot4 with higher score. If slot4 is last beat,
  // beat = null and collision = true.
  let slot5: BeatSlot
  if (dropIdx === beats.length - 1) {
    slot5 = {
      position: 5,
      kind: 'recovery',
      beat: null,
      timestampLabel: '',
      collision: true,
    }
  } else {
    const slot4Score = beats[dropIdx].score
    let recoveryBeat: Beat | null = null
    for (let i = dropIdx + 1; i < beats.length; i++) {
      if (beats[i].score - slot4Score >= 1.0) {
        recoveryBeat = beats[i]
        break
      }
    }
    if (!recoveryBeat) {
      for (let i = dropIdx + 1; i < beats.length; i++) {
        if (beats[i].score > slot4Score) {
          recoveryBeat = beats[i]
          break
        }
      }
    }
    slot5 = makeSlot(5, 'recovery', recoveryBeat)
  }

  // Slot 6: peak = highest score overall. Ties → earliest.
  let peakIdx = 0
  for (let i = 1; i < beats.length; i++) {
    if (beats[i].score > beats[peakIdx].score) {
      peakIdx = i
    }
  }
  const slot6 = makeSlot(6, 'peak', beats[peakIdx])

  // Slot 7: ending = last beat
  const slot7 = makeSlot(7, 'ending', beats[beats.length - 1])

  const slots: BeatSlot[] = [slot1, slot2, slot3, slot4, slot5, slot6, slot7, slot8]

  dedupMiddleSlots(slots, beats, runtimeMinutes)

  // Collision detection — positions 2-7. Mark any slot whose beat timestamp
  // is shared. After dedup this only fires when duplicateTimestamp was set.
  const usage = new Map<number, number>()
  for (const s of slots) {
    if (s.beat && s.position >= 2 && s.position <= 7) {
      const t = s.beat.timeMidpoint
      usage.set(t, (usage.get(t) ?? 0) + 1)
    }
  }
  for (const s of slots) {
    if (
      s.position >= 2 &&
      s.position <= 7 &&
      s.beat &&
      (usage.get(s.beat.timeMidpoint) ?? 0) > 1
    ) {
      s.collision = true
    }
  }

  return slots
}
