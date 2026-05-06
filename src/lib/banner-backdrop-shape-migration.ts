/**
 * Pure migration body for rewriting legacy BACKDROP bannerValue plain
 * filmId strings into the PR 1c JSON-encoded shape.
 *
 *   { filmId: string, backdropPath: string | null }  =>  JSON.stringify(...)
 *
 * The script in scripts/migrate-banner-backdrop-shape.ts wires real
 * Prisma calls into these deps. Tests pass mocked deps directly, no
 * module-level mocking required. Living under src/lib keeps the
 * function importable via the @/ alias from src/__tests__/.
 *
 * Idempotent: each row is checked against `isAlreadyMigrated` before
 * writing. The script also applies a SQL-level NOT startsWith('{')
 * filter so re-runs only see the leftover legacy rows.
 */

interface BackdropRow {
  id: string
  bannerValue: string
}

export interface MigrationDeps {
  findRows: () => Promise<BackdropRow[]>
  updateRow: (id: string, bannerValue: string) => Promise<void>
  log: (message: string) => void
}

export interface MigrationResult {
  migrated: number
  skipped: number
  total: number
}

export async function runBannerBackdropShapeMigration(
  deps: MigrationDeps
): Promise<MigrationResult> {
  const rows = await deps.findRows()
  const total = rows.length
  deps.log(`Found ${total} BACKDROP rows in legacy plain-string shape.`)

  let migrated = 0
  let skipped = 0

  for (const row of rows) {
    if (isAlreadyMigrated(row.bannerValue)) {
      skipped++
      continue
    }
    const next = JSON.stringify({ filmId: row.bannerValue, backdropPath: null })
    await deps.updateRow(row.id, next)
    migrated++
  }

  deps.log(`Migrated ${migrated} rows, skipped ${skipped} already-migrated rows.`)
  return { migrated, skipped, total }
}

export function isAlreadyMigrated(bannerValue: string): boolean {
  if (!bannerValue.startsWith('{')) return false
  try {
    const parsed = JSON.parse(bannerValue)
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { filmId?: unknown }).filmId === 'string'
    )
  } catch {
    return false
  }
}
