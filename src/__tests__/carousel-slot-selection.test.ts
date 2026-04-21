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
    it('narrative and chronological order coincide: slots 2-7 stay in opening-setup-drop-recovery-peak-ending order', () => {
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
    it('chronologically assigns the 6 dedup-resolved picks to slots 2-7', () => {
      const runtime = 100
      const total = 10
      // Monotonic 5.5 → 8.5: step = 3.0 / 9
      const step = 3.0 / 9
      const scores = Array.from({ length: total }, (_, i) => 5.5 + step * i)
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      // Narrative picks: opening=beats[0] (t=5), setup=beats[3] (t=35),
      // drop→beats[1] after dedup (t=15), recovery→beats[4] after dedup (t=45),
      // peak=beats[9] (t=95), ending→beats[8] after dedup (t=85).
      // Chronological assignment to slots 2-7: 5, 15, 35, 45, 85, 95.
      expect(slots[1].beat).toBe(beats[0])
      expect(slots[2].beat).toBe(beats[1])
      expect(slots[3].beat).toBe(beats[3])
      expect(slots[4].beat).toBe(beats[4])
      expect(slots[5].beat).toBe(beats[8])
      expect(slots[6].beat).toBe(beats[9])

      // Each slot's kind reflects the role that picked it, not its slot order.
      expect(slots[1].kind).toBe('opening')
      expect(slots[2].kind).toBe('drop')
      expect(slots[3].kind).toBe('setup')
      expect(slots[4].kind).toBe('recovery')
      expect(slots[5].kind).toBe('ending')
      expect(slots[6].kind).toBe('peak')

      // No collisions or duplicate flags.
      for (let i = 1; i <= 6; i++) {
        expect(slots[i].collision).toBe(false)
        expect(slots[i].duplicateTimestamp).toBeFalsy()
      }
    })
  })

  describe('c) Flat arc', () => {
    it('returns all 8 slots with every middle slot filled chronologically', () => {
      const runtime = 100
      const total = 10
      const scores = [6.4, 6.8, 7.0, 6.5, 7.1, 7.2, 6.9, 6.7, 7.0, 6.6]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      expect(slots).toHaveLength(8)
      expect(slots[0].beat).toBeNull() // hook
      expect(slots[7].beat).toBeNull() // takeaway
      for (let i = 1; i <= 6; i++) {
        expect(slots[i].beat).not.toBeNull()
        expect(beats).toContain(slots[i].beat)
      }
      // Middle slots are chronologically ordered by time.
      const times = slots.slice(1, 7).map((s) => s.beat!.timeMidpoint)
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThan(times[i - 1])
      }
    })
  })

  describe('d) Peak at end', () => {
    it('chronologically orders opening-drop-setup-recovery-ending-peak after dedup', () => {
      const runtime = 100
      const total = 10
      const scores = [6.0, 6.2, 6.4, 6.5, 6.7, 6.9, 7.1, 7.3, 7.6, 8.0]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      // Narrative picks → opening=beats[0], setup=beats[3], drop→beats[0] then
      // deduped to beats[1]. Recovery is computed against the pre-dedup drop
      // (s=6.0), so the first post-drop rise ≥1.0 is beats[6] (s=7.1), not
      // beats[7]. Peak=beats[9], ending=beats[9] dedupes to beats[8].
      // Chronological: 5, 15, 35, 65, 85, 95.
      expect(slots[1].beat).toBe(beats[0])
      expect(slots[2].beat).toBe(beats[1])
      expect(slots[3].beat).toBe(beats[3])
      expect(slots[4].beat).toBe(beats[6])
      expect(slots[5].beat).toBe(beats[8])
      expect(slots[6].beat).toBe(beats[9])
      for (let i = 1; i <= 6; i++) {
        expect(slots[i].collision).toBe(false)
      }
    })
  })

  describe('e) Low at end', () => {
    it('recovery falls back to window when drop is the last beat; chronological order preserved', () => {
      const runtime = 100
      const total = 10
      const scores = [7.0, 7.2, 7.5, 7.8, 7.4, 7.6, 7.2, 6.8, 6.5, 4.5]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      // Narrative picks → opening=beats[0], setup=beats[3], drop=beats[9],
      // recovery=null (no post-drop beats) → fallback-by-window (50-70) → beats[6],
      // peak=beats[3] collides with setup → dedup to beats[5],
      // ending=beats[9] collides with drop → dedup walk back to beats[8].
      // Chronological: 5, 35, 55, 65, 85, 95.
      expect(slots[1].beat).toBe(beats[0])
      expect(slots[2].beat).toBe(beats[3])
      expect(slots[3].beat).toBe(beats[5])
      expect(slots[4].beat).toBe(beats[6])
      expect(slots[4].kind).toBe('fallback')
      expect(slots[5].beat).toBe(beats[8])
      expect(slots[6].beat).toBe(beats[9])
      for (let i = 1; i <= 6; i++) {
        expect(slots[i].collision).toBe(false)
      }
    })
  })

  describe('f) Short film (3 beats)', () => {
    it('fills slots 2-4 chronologically and duplicates the last beat for 5-7', () => {
      const runtime = 60
      const total = 3
      const scores = [6.0, 7.5, 5.0]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      expect(slots).toHaveLength(8)
      expect(slots[0].beat).toBeNull()
      expect(slots[7].beat).toBeNull()

      // Three distinct beats chronologically: beats[0] (t=10), beats[1] (t=30), beats[2] (t=50).
      expect(slots[1].beat).toBe(beats[0])
      expect(slots[2].beat).toBe(beats[1])
      expect(slots[3].beat).toBe(beats[2])

      // Remaining slots duplicate the last assigned beat, flagged.
      expect(slots[4].beat).toBe(beats[2])
      expect(slots[5].beat).toBe(beats[2])
      expect(slots[6].beat).toBe(beats[2])
      expect(slots[4].duplicateTimestamp).toBe(true)
      expect(slots[5].duplicateTimestamp).toBe(true)
      expect(slots[6].duplicateTimestamp).toBe(true)

      // Slots sharing t=50 all flag collision.
      expect(slots[3].collision).toBe(true)
      expect(slots[4].collision).toBe(true)
      expect(slots[5].collision).toBe(true)
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

  describe('Setup and recovery pick the same beat naturally', () => {
    it('dedup shifts recovery; chronological order places drop→setup→recovery in slots 3-5', () => {
      const runtime = 100
      const total = 10
      // Early drop at index 1 (4.0) followed by a strong spike at index 2 (7.5),
      // which is both the highest score in the first 40% (setup target) AND
      // the first post-drop rise ≥ 1.0 (recovery target) — guaranteed collision.
      const scores = [7.0, 4.0, 7.5, 6.0, 5.5, 8.0, 8.5, 9.0, 9.5, 8.8]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      // Chronological: opening (5), drop (15), setup (25), recovery (35), peak (85), ending (95).
      expect(slots[1].beat).toBe(beats[0])
      expect(slots[2].beat).toBe(beats[1])
      expect(slots[3].beat).toBe(beats[2]) // setup retains
      expect(slots[4].beat).toBe(beats[3]) // recovery shifts from beats[2]
      expect(slots[5].beat).toBe(beats[8])
      expect(slots[6].beat).toBe(beats[9])
      for (let i = 1; i <= 6; i++) {
        expect(slots[i].duplicateTimestamp).toBeFalsy()
        expect(slots[i].collision).toBe(false)
      }
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

      // With only 4 beats feeding 6 middle slots, at least one slot must be
      // flagged duplicateTimestamp.
      const flagged = slots.filter((s) => s.duplicateTimestamp === true)
      expect(flagged.length).toBeGreaterThan(0)

      // Every middle slot has a usable (non-null) beat — duplicate fill preserves
      // the beat reference rather than returning null.
      for (let i = 1; i <= 6; i++) {
        expect(slots[i].beat).not.toBeNull()
      }
    })
  })
})

describe('selectBeatSlots — chronological reassignment', () => {
  describe('Kill Bill Vol. 1-like arc (sustained high, no clear drop)', () => {
    it('fills all 6 middle slots without crashing and orders them chronologically', () => {
      const runtime = 111
      const total = 10
      // All scores in [8, 9.5] — no red/gold dots, no single obvious drop.
      const scores = [8.3, 8.7, 9.0, 8.8, 9.2, 8.9, 9.4, 9.1, 8.8, 9.0]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      expect(slots).toHaveLength(8)
      for (let i = 1; i <= 6; i++) {
        expect(slots[i].beat).not.toBeNull()
      }
      const times = slots.slice(1, 7).map((s) => s.beat!.timeMidpoint)
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThan(times[i - 1])
      }
    })
  })

  describe('12 Angry Men-like arc (no early beats, tight cluster)', () => {
    it('assigns chronologically even when every beat lives after t=runtime*0.3', () => {
      const beats: Beat[] = [
        { timeStart: 25, timeEnd: 35, timeMidpoint: 30, score: 7.5, label: 'a', labelFull: 'a', confidence: 'medium', reviewEvidence: '' },
        { timeStart: 35, timeEnd: 45, timeMidpoint: 40, score: 7.8, label: 'b', labelFull: 'b', confidence: 'medium', reviewEvidence: '' },
        { timeStart: 50, timeEnd: 60, timeMidpoint: 55, score: 8.2, label: 'c', labelFull: 'c', confidence: 'medium', reviewEvidence: '' },
        { timeStart: 60, timeEnd: 70, timeMidpoint: 65, score: 6.5, label: 'd', labelFull: 'd', confidence: 'medium', reviewEvidence: '' },
        { timeStart: 70, timeEnd: 80, timeMidpoint: 75, score: 8.5, label: 'e', labelFull: 'e', confidence: 'medium', reviewEvidence: '' },
        { timeStart: 80, timeEnd: 95, timeMidpoint: 88, score: 9.0, label: 'f', labelFull: 'f', confidence: 'medium', reviewEvidence: '' },
      ]
      const runtime = 96
      const slots = selectBeatSlots(beats, runtime)

      for (let i = 1; i <= 6; i++) {
        expect(slots[i].beat).not.toBeNull()
      }
      const times = slots.slice(1, 7).map((s) => s.beat!.timeMidpoint)
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
      }
      // Every slot is filled by one of the 6 input beats (no duplicates).
      const unique = new Set(times)
      expect(unique.size).toBe(6)
    })
  })

  describe('Narrative picks out of chronological order get reordered', () => {
    it('when peak precedes drop in time, peak lands in an earlier slot than drop', () => {
      const runtime = 100
      const total = 10
      // Early mini-peak at index 2 (9.5, t=25), then deep drop at index 8 (4.0, t=85).
      const scores = [5.0, 6.0, 9.5, 7.0, 7.5, 7.8, 7.5, 7.0, 4.0, 6.0]
      const beats = scores.map((s, i) => mkBeat(i, runtime, total, s))
      const slots = selectBeatSlots(beats, runtime)

      const peakSlot = slots.find((s) => s.originalRole === 'peak')
      const dropSlot = slots.find((s) => s.originalRole === 'drop')
      expect(peakSlot).toBeDefined()
      expect(dropSlot).toBeDefined()
      expect(peakSlot!.beat!.timeMidpoint).toBeLessThan(dropSlot!.beat!.timeMidpoint)
      expect(peakSlot!.position).toBeLessThan(dropSlot!.position)
    })
  })
})
