// Minimal debouncer used by the slide editing UI. Intentionally does not use
// any React/DOM APIs so it can be unit-tested with vitest's fake timers.
//
// Semantics:
//   - trigger()  schedules fn to run after `ms`, resetting any pending timer
//   - flush()    runs fn immediately if pending, otherwise no-op
//   - cancel()   drops the pending run without firing
//
// After flush/cancel the debouncer is reusable — trigger() schedules a new run.

export type Debouncer = {
  trigger: () => void
  flush: () => void
  cancel: () => void
  isPending: () => boolean
}

export function createDebouncer(fn: () => void, ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    trigger() {
      clear()
      timer = setTimeout(() => {
        timer = null
        fn()
      }, ms)
    },
    flush() {
      if (timer !== null) {
        clear()
        fn()
      }
    },
    cancel() {
      clear()
    },
    isPending() {
      return timer !== null
    },
  }
}
