import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDebouncer } from '@/lib/carousel/debouncer'

describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires once after the delay elapses', () => {
    const fn = vi.fn()
    const d = createDebouncer(fn, 750)
    d.trigger()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(749)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('coalesces rapid triggers into a single fire', () => {
    const fn = vi.fn()
    const d = createDebouncer(fn, 750)
    d.trigger()
    vi.advanceTimersByTime(500)
    d.trigger()
    vi.advanceTimersByTime(500)
    d.trigger()
    vi.advanceTimersByTime(749)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('flush runs immediately and cancels the pending timer', () => {
    const fn = vi.fn()
    const d = createDebouncer(fn, 750)
    d.trigger()
    expect(d.isPending()).toBe(true)
    d.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(d.isPending()).toBe(false)
    // Advancing time must not cause a second fire.
    vi.advanceTimersByTime(2000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('flush is a no-op when nothing is pending', () => {
    const fn = vi.fn()
    const d = createDebouncer(fn, 750)
    d.flush()
    expect(fn).not.toHaveBeenCalled()
  })

  it('cancel drops the pending run without firing', () => {
    const fn = vi.fn()
    const d = createDebouncer(fn, 750)
    d.trigger()
    d.cancel()
    expect(d.isPending()).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(fn).not.toHaveBeenCalled()
  })

  it('is reusable — trigger after flush schedules again', () => {
    const fn = vi.fn()
    const d = createDebouncer(fn, 750)
    d.trigger()
    d.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    d.trigger()
    vi.advanceTimersByTime(750)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
