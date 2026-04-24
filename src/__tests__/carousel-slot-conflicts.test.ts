import { describe, it, expect } from 'vitest'
import {
  conflictsForSlot,
  buildConflictMap,
  hasConflict,
} from '@/lib/carousel/slot-conflicts'

function slot(position: number, t: number | null) {
  return { position, beatTimestamp: t }
}

describe('slot-conflicts', () => {
  describe('conflictsForSlot', () => {
    it('returns empty when no other slot shares the timestamp', () => {
      const slots = [
        slot(2, 5), slot(3, 25), slot(4, 50),
        slot(5, 75), slot(6, 100), slot(7, 150),
      ]
      expect(conflictsForSlot(slots, 4)).toEqual([])
    })

    it('reports the OTHER positions that share the same timestamp', () => {
      const slots = [
        slot(2, 5), slot(3, 50), slot(4, 50),
        slot(5, 75), slot(6, 50), slot(7, 150),
      ]
      // Slot 3, 4, 6 all share t=50. Querying 4 returns [3, 6] (excluding self).
      expect(conflictsForSlot(slots, 4)).toEqual([3, 6])
      expect(conflictsForSlot(slots, 3)).toEqual([4, 6])
      expect(conflictsForSlot(slots, 6)).toEqual([3, 4])
    })

    it('ignores hook (1) and takeaway (8) even if they share a timestamp', () => {
      const slots = [
        slot(1, 50), slot(2, 5), slot(3, 50),
        slot(4, 60), slot(5, 75), slot(6, 90),
        slot(7, 50), slot(8, 50),
      ]
      // Querying 3: only middle slots considered. 7 also has t=50 → [7].
      expect(conflictsForSlot(slots, 3)).toEqual([7])
    })

    it('returns empty for slot with null beatTimestamp', () => {
      const slots = [
        slot(2, 5), slot(3, null), slot(4, 50),
        slot(5, 75), slot(6, 100), slot(7, 150),
      ]
      expect(conflictsForSlot(slots, 3)).toEqual([])
    })

    it('returns empty when queried position is not in the slot list', () => {
      const slots = [slot(2, 5), slot(3, 25)]
      expect(conflictsForSlot(slots, 4)).toEqual([])
    })

    it('output is sorted ascending', () => {
      const slots = [
        slot(2, 50), slot(7, 50), slot(3, 50),
        slot(5, 50), slot(4, 100), slot(6, 100),
      ]
      expect(conflictsForSlot(slots, 4)).toEqual([6])
      expect(conflictsForSlot(slots, 5)).toEqual([2, 3, 7])
    })
  })

  describe('buildConflictMap', () => {
    it('returns one entry per middle slot, populated from conflictsForSlot', () => {
      const slots = [
        slot(2, 5), slot(3, 50), slot(4, 50),
        slot(5, 75), slot(6, 100), slot(7, 100),
      ]
      expect(buildConflictMap(slots)).toEqual({
        2: [],
        3: [4],
        4: [3],
        5: [],
        6: [7],
        7: [6],
      })
    })

    it('skips hook and takeaway entries entirely', () => {
      const slots = [
        slot(1, 0), slot(2, 5), slot(3, 25),
        slot(4, 50), slot(5, 75), slot(6, 100),
        slot(7, 150), slot(8, 160),
      ]
      const map = buildConflictMap(slots)
      expect(Object.keys(map).sort()).toEqual(['2', '3', '4', '5', '6', '7'])
    })
  })

  describe('hasConflict', () => {
    it('true when at least one other middle slot shares the timestamp', () => {
      const slots = [
        slot(2, 5), slot(3, 50), slot(4, 50),
        slot(5, 75), slot(6, 100), slot(7, 150),
      ]
      expect(hasConflict(slots, 3)).toBe(true)
      expect(hasConflict(slots, 4)).toBe(true)
      expect(hasConflict(slots, 5)).toBe(false)
    })
  })
})
