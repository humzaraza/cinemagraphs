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
    it('slot 4 → index 0, slot 6 → index 9, slot 7 → index 9 with collisions on 6 and 7', () => {
      const runtime = 100
      const total = 10
      // Monotonic 5.5 → 8.5: step = 3.0 / 9
      const step = 3.0 / 9
      const scores = Array.from({ length: total }, (_, i) => 5.5 + step * i)
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      expect(slots[3].beat).toBe(beats[0])
      expect(slots[5].beat).toBe(beats[9])
      expect(slots[6].beat).toBe(beats[9])
      expect(slots[5].collision).toBe(true)
      expect(slots[6].collision).toBe(true)
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
    it('flags collision on slots 6 and 7 when peak == beats[last]', () => {
      const runtime = 100
      const total = 10
      const scores = [6.0, 6.2, 6.4, 6.5, 6.7, 6.9, 7.1, 7.3, 7.6, 8.0]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      expect(slots[5].beat).toBe(beats[9])
      expect(slots[6].beat).toBe(beats[9])
      expect(slots[5].collision).toBe(true)
      expect(slots[6].collision).toBe(true)
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
