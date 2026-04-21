import { describe, it, expect } from 'vitest'
import { selectBeatSlots, formatTimestamp, type Beat } from '@/lib/carousel/slot-selection'

function mkBeat(i: number, runtime: number, total: number, score: number): Beat {
  // Spread beats evenly across runtime — center at (i+0.5)/total of runtime.
  const timeMidpoint = Math.round(((i + 0.5) / total) * runtime)
  const span = runtime / total
  return {
    timeStart: Math.max(0, timeMidpoint - Math.round(span / 2)),
    timeEnd: Math.min(runtime, timeMidpoint + Math.round(span / 2)),
    timeMidpoint,
    score,
    label: `Beat ${i}`,
    labelFull: `Beat ${i} full`,
    confidence: 'medium',
    reviewEvidence: '',
  }
}

describe('formatTimestamp', () => {
  it('formats minutes under 60', () => {
    expect(formatTimestamp(0)).toBe('0m')
    expect(formatTimestamp(5)).toBe('5m')
    expect(formatTimestamp(59)).toBe('59m')
  })
  it('formats hours with minutes', () => {
    expect(formatTimestamp(60)).toBe('1h')
    expect(formatTimestamp(75)).toBe('1h 15m')
    expect(formatTimestamp(120)).toBe('2h')
    expect(formatTimestamp(125)).toBe('2h 5m')
    expect(formatTimestamp(115)).toBe('1h 55m')
  })
})

describe('selectBeatSlots', () => {
  describe('a) V-shape', () => {
    it('picks low at index 3 for slot 4 and peak at index 8 for slot 6; slot 5 recovers by >= 1.0', () => {
      const runtime = 100
      const total = 10
      const scores = [7.0, 7.2, 6.8, 4.5, 5.0, 6.0, 7.5, 8.8, 9.5, 8.0]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      expect(slots[3].kind).toBe('drop')
      expect(slots[3].beat).toBe(beats[3])
      expect(slots[5].kind).toBe('peak')
      expect(slots[5].beat).toBe(beats[8])
      expect(slots[4].kind).toBe('recovery')
      expect(slots[4].beat).not.toBeNull()
      expect((slots[4].beat!.score - beats[3].score)).toBeGreaterThanOrEqual(1.0)
    })
  })

  describe('b) Sustained climb', () => {
    it('dedup resolves both the opening==drop and peak==ending collisions', () => {
      const runtime = 100
      const total = 10
      // Monotonic 5.5 → 8.5: step = 3.0 / 9
      const step = 3.0 / 9
      const scores = Array.from({ length: total }, (_, i) => 5.5 + step * i)
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      // slot 4 (drop): beats[0] is lowest but taken by slot 2 (opening). Dedup shifts to beats[1].
      expect(slots[3].beat).toBe(beats[1])
      // slot 6 (peak) stays at beats[9] (highest score).
      expect(slots[5].beat).toBe(beats[9])
      // slot 7 (ending) would be beats[9], colliding with slot 6. Dedup steps backward to beats[8].
      expect(slots[6].beat).toBe(beats[8])
      // No collisions or duplicate flags remain — alternatives were found everywhere.
      expect(slots[3].collision).toBe(false)
      expect(slots[5].collision).toBe(false)
      expect(slots[6].collision).toBe(false)
      expect(slots[3].duplicateTimestamp).toBeFalsy()
      expect(slots[5].duplicateTimestamp).toBeFalsy()
      expect(slots[6].duplicateTimestamp).toBeFalsy()
    })
  })

  describe('c) Flat arc', () => {
    it('returns all 8 slots with valid beats or nulls and does not crash', () => {
      const runtime = 100
      const total = 10
      const scores = [6.4, 6.8, 7.0, 6.5, 7.1, 7.2, 6.9, 6.7, 7.0, 6.6]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      expect(slots).toHaveLength(8)
      expect(slots[0].beat).toBeNull() // hook
      expect(slots[7].beat).toBeNull() // takeaway
      for (let i = 1; i <= 6; i++) {
        // Either a valid beat reference from the input, or null (slot 5 edge case only)
        if (slots[i].beat !== null) {
          expect(beats).toContain(slots[i].beat)
        }
      }
      // Log picks for manual review per spec
      const picks = slots.map((s) => ({
        pos: s.position,
        kind: s.kind,
        score: s.beat?.score ?? null,
        label: s.beat?.label ?? null,
        collision: s.collision,
      }))
      console.log('[flat-arc picks]', JSON.stringify(picks, null, 2))
    })
  })

  describe('d) Peak at end', () => {
    it('dedup resolves peak==ending collision: slot 7 steps backward to beats[8]', () => {
      const runtime = 100
      const total = 10
      const scores = [6.0, 6.2, 6.4, 6.5, 6.7, 6.9, 7.1, 7.3, 7.6, 8.0]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      // slot 4 (drop): beats[0] lowest but taken by slot 2. Dedup shifts to beats[1].
      expect(slots[3].beat).toBe(beats[1])
      // slot 6 (peak) stays at beats[9].
      expect(slots[5].beat).toBe(beats[9])
      // slot 7 (ending) would be beats[9], colliding with slot 6. Step backward → beats[8].
      expect(slots[6].beat).toBe(beats[8])
      expect(slots[5].collision).toBe(false)
      expect(slots[6].collision).toBe(false)
    })
  })

  describe('e) Low at end', () => {
    it('slot 5 beat is null and collision is true when low == beats[last]', () => {
      const runtime = 100
      const total = 10
      const scores = [7.0, 7.2, 7.5, 7.8, 7.4, 7.6, 7.2, 6.8, 6.5, 4.5]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      expect(slots[3].beat).toBe(beats[9])
      expect(slots[4].beat).toBeNull()
      expect(slots[4].collision).toBe(true)
    })
  })

  describe('f) Short film (3 beats)', () => {
    it('returns all 8 slots and correctly flags collisions', () => {
      const runtime = 60
      const total = 3
      const scores = [6.0, 7.5, 5.0]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      expect(slots).toHaveLength(8)
      expect(slots[0].beat).toBeNull()
      expect(slots[7].beat).toBeNull()

      // Slot 2 (opening) = beats[0]
      expect(slots[1].beat).toBe(beats[0])
      // Slot 4 (drop) = lowest score = beats[2]
      expect(slots[3].beat).toBe(beats[2])
      // Slot 5 (recovery) — drop is last beat → beat null, collision true
      expect(slots[4].beat).toBeNull()
      expect(slots[4].collision).toBe(true)
      // Slot 6 (peak) = beats[1]
      expect(slots[5].beat).toBe(beats[1])
      // Slot 7 (ending) = beats[2]
      expect(slots[6].beat).toBe(beats[2])

      // Slot 4 and 7 both use beats[2] — both should be flagged
      expect(slots[3].collision).toBe(true)
      expect(slots[6].collision).toBe(true)
    })
  })
})

describe('selectBeatSlots — dedup pass', () => {
  describe('Standard PHM-like arc with distinct beats', () => {
    it('produces no duplicate timestamps and no flags', () => {
      const runtime = 100
      const total = 10
      // V-shape with a clear peak — mirrors PHM's overall silhouette.
      const scores = [7.0, 7.2, 6.8, 4.5, 5.0, 6.0, 7.5, 8.8, 9.5, 8.0]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      const middleTs = slots
        .filter((s) => s.position >= 2 && s.position <= 7 && s.beat)
        .map((s) => s.beat!.timeMidpoint)
      expect(new Set(middleTs).size).toBe(middleTs.length) // all distinct

      for (let i = 1; i <= 6; i++) {
        expect(slots[i].duplicateTimestamp).toBeFalsy()
        expect(slots[i].collision).toBe(false)
      }
    })
  })

  describe('Slot 3 (setup) and slot 5 (recovery) would naturally resolve to the same beat', () => {
    it('after dedup, slot 5 shifts to a different beat; neither is flagged', () => {
      const runtime = 100
      const total = 10
      // Early drop at index 1 (4.0) followed by a strong spike at index 2 (7.5),
      // which is both the highest score in the first 40% (slot 3 target) AND
      // the first post-drop rise ≥ 1.0 (slot 5 target) — guaranteed collision.
      const scores = [7.0, 4.0, 7.5, 6.0, 5.5, 8.0, 8.5, 9.0, 9.5, 8.8]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      // slot 3 (setup) retains beats[2] — highest in first 40%.
      expect(slots[2].beat).toBe(beats[2])
      // slot 5 (recovery) must shift away from beats[2]; beats[3] (6.0, rise=2.0 from 4.0) is the next qualifying beat.
      expect(slots[4].beat).not.toBe(beats[2])
      expect(slots[4].beat).not.toBeNull()
      expect(slots[4].beat!.score - beats[1].score).toBeGreaterThanOrEqual(1.0)
      // Neither slot flagged.
      expect(slots[2].duplicateTimestamp).toBeFalsy()
      expect(slots[4].duplicateTimestamp).toBeFalsy()
      expect(slots[2].collision).toBe(false)
      expect(slots[4].collision).toBe(false)
    })
  })

  describe('Arc with only 4 distinct beats and 6 middle slots', () => {
    it('some slots are flagged duplicateTimestamp and the pipeline does not crash', () => {
      const beats: Beat[] = [
        { timeStart: 0, timeEnd: 15, timeMidpoint: 7, score: 6.5, label: 'b0', labelFull: 'b0', confidence: 'medium', reviewEvidence: '' },
        { timeStart: 15, timeEnd: 30, timeMidpoint: 22, score: 8.0, label: 'b1', labelFull: 'b1', confidence: 'medium', reviewEvidence: '' },
        { timeStart: 30, timeEnd: 50, timeMidpoint: 40, score: 5.0, label: 'b2', labelFull: 'b2', confidence: 'medium', reviewEvidence: '' },
        { timeStart: 50, timeEnd: 80, timeMidpoint: 65, score: 7.5, label: 'b3', labelFull: 'b3', confidence: 'medium', reviewEvidence: '' },
      ]
      const runtime = 80

      // Must not throw.
      const slots = selectBeatSlots(beats, runtime)
      expect(slots).toHaveLength(8)

      // With only 4 beats feeding 6 middle slots, at least one slot must fail
      // dedup and land on duplicateTimestamp=true.
      const flagged = slots.filter((s) => s.duplicateTimestamp === true)
      expect(flagged.length).toBeGreaterThan(0)

      // Every middle slot still has a usable (non-null) beat — the duplicate
      // flag preserves the original rather than returning null.
      for (let i = 1; i <= 6; i++) {
        // slot 5 may be null if drop is last beat; skip that edge case here.
        if (slots[i].kind === 'recovery' && slots[i].beat === null) continue
        expect(slots[i].beat).not.toBeNull()
      }
    })
  })
})
