import { describe, it, expect, vi } from 'vitest'
import {
  runBannerBackdropShapeMigration,
  isAlreadyMigrated,
} from '@/lib/banner-backdrop-shape-migration'

interface FakeRow {
  id: string
  bannerValue: string
}

function makeDeps(initial: FakeRow[]) {
  // Simulate the underlying DB so re-running the migration sees its own
  // earlier writes. Mirrors how the SQL-level NOT startsWith('{') filter
  // would behave on a real Postgres row after an initial migration.
  const store = new Map<string, string>(initial.map((r) => [r.id, r.bannerValue]))
  const log = vi.fn()
  const findRows = vi.fn(async () =>
    Array.from(store.entries())
      .filter(([, v]) => !v.startsWith('{'))
      .map(([id, bannerValue]) => ({ id, bannerValue }))
  )
  const updateRow = vi.fn(async (id: string, bannerValue: string) => {
    store.set(id, bannerValue)
  })
  return { findRows, updateRow, log, store }
}

describe('runBannerBackdropShapeMigration', () => {
  it('rewrites plain-string filmId rows to JSON-encoded shape with null backdropPath', async () => {
    const deps = makeDeps([
      { id: 'user_1', bannerValue: 'film_godfather' },
      { id: 'user_2', bannerValue: 'film_kane' },
    ])

    const result = await runBannerBackdropShapeMigration(deps)

    expect(result).toEqual({ migrated: 2, skipped: 0, total: 2 })
    expect(deps.updateRow).toHaveBeenCalledWith(
      'user_1',
      JSON.stringify({ filmId: 'film_godfather', backdropPath: null })
    )
    expect(deps.updateRow).toHaveBeenCalledWith(
      'user_2',
      JSON.stringify({ filmId: 'film_kane', backdropPath: null })
    )
    expect(deps.store.get('user_1')).toBe(
      JSON.stringify({ filmId: 'film_godfather', backdropPath: null })
    )
    expect(deps.store.get('user_2')).toBe(
      JSON.stringify({ filmId: 'film_kane', backdropPath: null })
    )
  })

  it('is idempotent: a second run after a successful first run does nothing', async () => {
    const deps = makeDeps([{ id: 'user_1', bannerValue: 'film_godfather' }])

    const first = await runBannerBackdropShapeMigration(deps)
    expect(first).toEqual({ migrated: 1, skipped: 0, total: 1 })
    expect(deps.updateRow).toHaveBeenCalledTimes(1)

    deps.updateRow.mockClear()
    const second = await runBannerBackdropShapeMigration(deps)
    expect(second).toEqual({ migrated: 0, skipped: 0, total: 0 })
    expect(deps.updateRow).not.toHaveBeenCalled()
  })

  it('handles a mix of legacy and already-migrated rows in a single pass (defensive in-process check)', async () => {
    // findRows in this test deliberately returns rows that DO start
    // with '{' (i.e. as if the SQL prefix filter slipped). The in-
    // process isAlreadyMigrated check catches them.
    const log = vi.fn()
    const updateRow = vi.fn(async () => {})
    const findRows = vi.fn(async () => [
      { id: 'user_legacy', bannerValue: 'film_godfather' },
      {
        id: 'user_already',
        bannerValue: JSON.stringify({ filmId: 'film_godfather', backdropPath: null }),
      },
      { id: 'user_other', bannerValue: 'film_kane' },
    ])

    const result = await runBannerBackdropShapeMigration({ findRows, updateRow, log })

    expect(result).toEqual({ migrated: 2, skipped: 1, total: 3 })
    expect(updateRow).toHaveBeenCalledTimes(2)
    expect(updateRow).toHaveBeenCalledWith(
      'user_legacy',
      JSON.stringify({ filmId: 'film_godfather', backdropPath: null })
    )
    expect(updateRow).toHaveBeenCalledWith(
      'user_other',
      JSON.stringify({ filmId: 'film_kane', backdropPath: null })
    )
    expect(updateRow).not.toHaveBeenCalledWith('user_already', expect.any(String))
  })

  it('returns 0/0/0 and logs counts when there are no rows to process', async () => {
    const deps = makeDeps([])

    const result = await runBannerBackdropShapeMigration(deps)

    expect(result).toEqual({ migrated: 0, skipped: 0, total: 0 })
    expect(deps.updateRow).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      'Found 0 BACKDROP rows in legacy plain-string shape.'
    )
    expect(deps.log).toHaveBeenCalledWith(
      'Migrated 0 rows, skipped 0 already-migrated rows.'
    )
  })

  it('logs the start and end counts in the expected format', async () => {
    const deps = makeDeps([
      { id: 'user_1', bannerValue: 'film_godfather' },
      { id: 'user_2', bannerValue: 'film_kane' },
    ])

    await runBannerBackdropShapeMigration(deps)

    expect(deps.log).toHaveBeenCalledWith(
      'Found 2 BACKDROP rows in legacy plain-string shape.'
    )
    expect(deps.log).toHaveBeenCalledWith(
      'Migrated 2 rows, skipped 0 already-migrated rows.'
    )
  })
})

describe('isAlreadyMigrated', () => {
  it('returns false for a plain filmId string', () => {
    expect(isAlreadyMigrated('film_godfather')).toBe(false)
  })

  it('returns true for a JSON-encoded object with a string filmId', () => {
    expect(
      isAlreadyMigrated(JSON.stringify({ filmId: 'film_godfather', backdropPath: null }))
    ).toBe(true)
  })

  it('returns true for a JSON-encoded object with non-null backdropPath', () => {
    expect(
      isAlreadyMigrated(
        JSON.stringify({ filmId: 'film_godfather', backdropPath: '/abc.jpg' })
      )
    ).toBe(true)
  })

  it('returns false for malformed JSON that starts with {', () => {
    expect(isAlreadyMigrated('{not actually json')).toBe(false)
  })

  it('returns false for a JSON object missing filmId', () => {
    expect(isAlreadyMigrated(JSON.stringify({ backdropPath: null }))).toBe(false)
  })

  it('returns false for a JSON object whose filmId is not a string', () => {
    expect(isAlreadyMigrated(JSON.stringify({ filmId: 42, backdropPath: null }))).toBe(false)
  })

  it('returns false for a JSON array starting with {', () => {
    // Arrays start with '[' not '{' so this is just defensive.
    expect(isAlreadyMigrated('[]')).toBe(false)
  })
})
