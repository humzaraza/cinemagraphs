import type { SentimentDataPoint } from '@/lib/types'

export type Beat = SentimentDataPoint

// Narrative role a beat was picked as during phase 1 of selection. After the
// chronological reassignment in phase 2, this is preserved on the slot so
// body-copy generation can tell "this is the beat that was picked as the
// drop" vs. "this is the peak beat". Slots that could not be filled by the
// narrative pass use 'fallback'.
export type OriginalRole =
  | 'opening'
  | 'setup'
  | 'drop'
  | 'recovery'
  | 'peak'
  | 'ending'
  | 'fallback'

export type SlotKind = 'hook' | OriginalRole | 'takeaway'

export type SlotPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface BeatSlot {
  position: SlotPosition
  kind: SlotKind
  // Narrative role the beat at this slot was originally picked under. Set
  // only for middle slots (2-7) that ended up with a beat.
  originalRole?: OriginalRole
  beat: Beat | null
  timestampLabel: string
  collision: boolean
  // Set when the selector could not find a distinct beat for this slot and
  // had to reuse one already assigned elsewhere. Admin UI surfaces it as a
  // warning.
  duplicateTimestamp?: boolean
}

// Narrow projection of a middle slot for downstream consumers (body-copy
// generator, draft route). Decoupled from the wider BeatSlot so clients do
// not need to reason about hook/takeaway.
export type SlotSelection = {
  slideNumber: 2 | 3 | 4 | 5 | 6 | 7
  beatIndex: number
  originalRole: OriginalRole
  duplicateTimestamp?: boolean
}

// ── Timestamp formatting ──────────────────────────────────────

export function formatTimestamp(minutes: number): string {
  const total = Math.round(minutes)
  if (total >= 60) {
    const h = Math.floor(total / 60)
    const m = total - h * 60
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `${Math.max(0, total)}m`
}

// ── Narrative picking ─────────────────────────────────────────
// Each picker returns a Beat or null — null means "no beat fits this role
// under the original narrative rules". Phase 3 (fallback) fills nulls.

function pickOpening(beats: Beat[]): Beat | null {
  return beats[0] ?? null
}

function pickSetup(beats: Beat[], runtime: number): Beat | null {
  const threshold = runtime * 0.4
  let best: Beat | null = null
  for (let i = 1; i < beats.length; i++) {
    const b = beats[i]
    if (b.timeMidpoint < threshold) {
      if (!best || b.score > best.score) best = b
    }
  }
  if (!best) return beats[1] ?? null
  return best
}

function pickDrop(beats: Beat[]): Beat | null {
  if (beats.length === 0) return null
  let lowIdx = 0
  for (let i = 1; i < beats.length; i++) {
    if (beats[i].score < beats[lowIdx].score) lowIdx = i
  }
  return beats[lowIdx]
}

function pickRecovery(beats: Beat[], drop: Beat | null): Beat | null {
  if (!drop) return null
  const dropTime = drop.timeMidpoint
  const dropScore = drop.score
  // Prefer post-drop rise ≥ 1.0.
  for (const b of beats) {
    if (b.timeMidpoint > dropTime && b.score - dropScore >= 1.0) return b
  }
  // Fall back to any post-drop higher beat.
  for (const b of beats) {
    if (b.timeMidpoint > dropTime && b.score > dropScore) return b
  }
  return null
}

function pickPeak(beats: Beat[]): Beat | null {
  if (beats.length === 0) return null
  let hiIdx = 0
  for (let i = 1; i < beats.length; i++) {
    if (beats[i].score > beats[hiIdx].score) hiIdx = i
  }
  return beats[hiIdx]
}

function pickEnding(beats: Beat[]): Beat | null {
  return beats[beats.length - 1] ?? null
}

// ── Deduplication during narrative phase ──────────────────────
// If two roles pick the same beat, try to find an alternative for the later
// role using role-specific rules. Order matters: earlier roles in this list
// keep priority over later ones.

const NARRATIVE_ORDER: OriginalRole[] = [
  'opening',
  'setup',
  'drop',
  'recovery',
  'peak',
  'ending',
]

function findAlternativeForRole(
  role: OriginalRole,
  beats: Beat[],
  taken: Set<number>,
  drop: Beat | null,
  runtime: number,
): Beat | null {
  switch (role) {
    case 'opening': {
      const max = runtime * 0.1
      return (
        beats
          .filter((b) => b.timeMidpoint <= max && !taken.has(b.timeMidpoint))
          .sort((a, b) => a.timeMidpoint - b.timeMidpoint)[0] ?? null
      )
    }
    case 'setup': {
      const min = runtime * 0.1
      const max = runtime * 0.4
      return (
        beats
          .filter(
            (b) =>
              b.timeMidpoint >= min &&
              b.timeMidpoint < max &&
              !taken.has(b.timeMidpoint),
          )
          .sort(
            (a, b) => b.score - a.score || a.timeMidpoint - b.timeMidpoint,
          )[0] ?? null
      )
    }
    case 'drop': {
      const sorted = [...beats].sort(
        (a, b) => a.score - b.score || a.timeMidpoint - b.timeMidpoint,
      )
      for (const b of sorted) if (!taken.has(b.timeMidpoint)) return b
      return null
    }
    case 'recovery': {
      if (!drop) return null
      const dropTime = drop.timeMidpoint
      const dropScore = drop.score
      const after = beats.filter((b) => b.timeMidpoint > dropTime)
      for (const b of after) {
        if (b.score - dropScore >= 1.0 && !taken.has(b.timeMidpoint)) return b
      }
      for (const b of after) {
        if (b.score > dropScore && !taken.has(b.timeMidpoint)) return b
      }
      return null
    }
    case 'peak': {
      const sorted = [...beats].sort(
        (a, b) => b.score - a.score || a.timeMidpoint - b.timeMidpoint,
      )
      for (const b of sorted) if (!taken.has(b.timeMidpoint)) return b
      return null
    }
    case 'ending': {
      for (let i = beats.length - 1; i >= 0; i--) {
        if (!taken.has(beats[i].timeMidpoint)) return beats[i]
      }
      return null
    }
    default:
      return null
  }
}

// ── Fallback picking (phase 3) ────────────────────────────────
// When a role returns null and its narrative alternative also fails, pick a
// beat by the chronological window for the slot position it would occupy.
// The spec ties windows to *slot positions* (2-7), which map 1:1 to the
// narrative order in the pre-chronological assignment.

type Window =
  | { type: 'range'; min: number; max: number }
  | { type: 'center'; pct: number }

const ROLE_WINDOWS: Record<OriginalRole, Window | null> = {
  opening: { type: 'range', min: 0.0, max: 0.15 },
  setup: { type: 'range', min: 0.15, max: 0.4 },
  drop: { type: 'center', pct: 0.45 },
  recovery: { type: 'range', min: 0.5, max: 0.7 },
  peak: { type: 'center', pct: 0.75 },
  ending: { type: 'range', min: 0.85, max: 1.0 },
  fallback: null,
}

function fallbackByWindow(
  role: OriginalRole,
  beats: Beat[],
  taken: Set<number>,
  runtime: number,
): Beat | null {
  const win = ROLE_WINDOWS[role]
  if (!win) return null
  const unused = beats.filter((b) => !taken.has(b.timeMidpoint))
  if (unused.length === 0) return null
  if (win.type === 'range') {
    const min = runtime * win.min
    const max = runtime * win.max
    // Ending slot wants the LAST unused beat in its window; others want first.
    const inWindow = unused.filter(
      (b) => b.timeMidpoint >= min && b.timeMidpoint <= max,
    )
    if (inWindow.length > 0) {
      if (role === 'ending') return inWindow[inWindow.length - 1]
      return inWindow[0]
    }
    // No beat falls inside the window — pick the unused beat closest to the
    // window center so the chronological flow still roughly lines up.
    const target = (min + max) / 2
    return [...unused].sort(
      (a, b) =>
        Math.abs(a.timeMidpoint - target) - Math.abs(b.timeMidpoint - target),
    )[0]
  }
  const target = runtime * win.pct
  return [...unused].sort(
    (a, b) =>
      Math.abs(a.timeMidpoint - target) - Math.abs(b.timeMidpoint - target),
  )[0]
}

// ── Main entry point ──────────────────────────────────────────

function makeSlot(
  position: SlotPosition,
  kind: SlotKind,
  beat: Beat | null,
  originalRole?: OriginalRole,
): BeatSlot {
  return {
    position,
    kind,
    originalRole,
    beat,
    timestampLabel: beat ? formatTimestamp(beat.timeMidpoint) : '',
    collision: false,
  }
}

export function selectBeatSlots(
  beats: Beat[],
  runtimeMinutes: number,
): BeatSlot[] {
  const empty: BeatSlot[] = [
    makeSlot(1, 'hook', null),
    makeSlot(2, 'opening', null),
    makeSlot(3, 'setup', null),
    makeSlot(4, 'drop', null),
    makeSlot(5, 'recovery', null),
    makeSlot(6, 'peak', null),
    makeSlot(7, 'ending', null),
    makeSlot(8, 'takeaway', null),
  ]

  if (beats.length === 0) return empty

  // ── Phase 1: narrative pick per role ────────────────────────
  const narrative: Record<OriginalRole, Beat | null> = {
    opening: pickOpening(beats),
    setup: pickSetup(beats, runtimeMinutes),
    drop: pickDrop(beats),
    recovery: null, // set below after drop is known
    peak: pickPeak(beats),
    ending: pickEnding(beats),
    fallback: null,
  }
  narrative.recovery = pickRecovery(beats, narrative.drop)

  // ── Phase 2: dedupe within narrative picks ──────────────────
  // Walk in NARRATIVE_ORDER, tracking timestamps already assigned. If a role
  // would repeat, look up an alternative first (same role-specific rules as
  // before). If that fails too, leave null — phase 3 handles it.
  const taken = new Set<number>()
  for (const role of NARRATIVE_ORDER) {
    const beat = narrative[role]
    if (!beat) continue
    if (!taken.has(beat.timeMidpoint)) {
      taken.add(beat.timeMidpoint)
      continue
    }
    const alt = findAlternativeForRole(
      role,
      beats,
      taken,
      narrative.drop,
      runtimeMinutes,
    )
    narrative[role] = alt
    if (alt) taken.add(alt.timeMidpoint)
  }

  // ── Phase 3: fall back to time-window pick for any still-null role ──
  // Role becomes 'fallback' for any slot filled here.
  const roleOfSlot: Record<OriginalRole, OriginalRole> = {
    opening: 'opening',
    setup: 'setup',
    drop: 'drop',
    recovery: 'recovery',
    peak: 'peak',
    ending: 'ending',
    fallback: 'fallback',
  }
  for (const role of NARRATIVE_ORDER) {
    if (narrative[role]) continue
    const fb = fallbackByWindow(role, beats, taken, runtimeMinutes)
    if (fb) {
      narrative[role] = fb
      taken.add(fb.timeMidpoint)
      roleOfSlot[role] = 'fallback'
    }
  }

  // ── Phase 4: collect assigned (beat, role) pairs and sort by time ──
  const assigned: Array<{ beat: Beat; role: OriginalRole }> = []
  for (const role of NARRATIVE_ORDER) {
    const b = narrative[role]
    if (b) assigned.push({ beat: b, role: roleOfSlot[role] })
  }
  assigned.sort((a, b) => a.beat.timeMidpoint - b.beat.timeMidpoint)

  // ── Phase 5: assign to slots 2-7 in chronological order ────
  const slots = empty.slice()
  for (let i = 0; i < assigned.length && i < 6; i++) {
    const position = (i + 2) as SlotPosition
    const { beat, role } = assigned[i]
    slots[i + 1] = makeSlot(position, role as SlotKind, beat, role)
  }

  // ── Phase 6: if still fewer than 6 filled, duplicate the closest beat ──
  // This only fires for films with extremely few distinct beats (fewer than
  // 6). The duplicate is flagged so the admin UI can warn.
  for (let i = assigned.length; i < 6; i++) {
    const position = (i + 2) as SlotPosition
    // Find the nearest already-assigned beat by chronological position.
    if (assigned.length === 0) {
      slots[i + 1] = makeSlot(position, 'fallback' as SlotKind, null, 'fallback')
      slots[i + 1].duplicateTimestamp = true
      continue
    }
    const dup = assigned[Math.min(i, assigned.length - 1)]
    slots[i + 1] = makeSlot(position, dup.role as SlotKind, dup.beat, dup.role)
    slots[i + 1].duplicateTimestamp = true
  }

  // ── Phase 7: collision flag for any shared timestamp ───────
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

// Downstream projection for body-copy generation. Takes the full slot list
// plus the beats array (to resolve beatIndex) and emits a SlotSelection per
// middle slot. beatIndex is the position of the beat in the beats array; -1
// if the slot has no beat (shouldn't happen after fallback but guarded).
export function toSlotSelections(
  slots: BeatSlot[],
  beats: Beat[],
): SlotSelection[] {
  const out: SlotSelection[] = []
  for (const s of slots) {
    if (s.position < 2 || s.position > 7) continue
    if (!s.beat || !s.originalRole) continue
    const idx = beats.findIndex((b) => b.timeMidpoint === s.beat!.timeMidpoint)
    out.push({
      slideNumber: s.position as SlotSelection['slideNumber'],
      beatIndex: idx,
      originalRole: s.originalRole,
      duplicateTimestamp: s.duplicateTimestamp,
    })
  }
  return out
}
