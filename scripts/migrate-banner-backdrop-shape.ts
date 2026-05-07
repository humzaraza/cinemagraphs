/**
 * One-off data migration: rewrite legacy BACKDROP bannerValue plain
 * filmId strings into the PR 1c JSON-encoded shape.
 *
 * Background: PR 1b stored User.bannerValue as a plain filmId string
 * for BACKDROP banners. PR 1c extends BACKDROP so each user can pick
 * a specific TMDB backdrop, persisting the shape
 *   JSON.stringify({ filmId: string, backdropPath: string | null })
 * in the same String column. backdropPath=null falls back to the
 * Film's default backdropUrl, which preserves PR 1b rendering for
 * already-existing rows after migration.
 *
 * Idempotency:
 *   - SQL-level filter `NOT bannerValue startsWith '{'` excludes rows
 *     already in the new JSON shape, so a re-run after partial
 *     completion only processes leftover rows.
 *   - In-process safety net inside runBannerBackdropShapeMigration also
 *     skips any row whose bannerValue parses as JSON to an object with
 *     a string filmId, in case a future shape mutation slips past the
 *     prefix filter.
 *
 * This script runs ONCE manually after PR 1c deploys to production.
 * It does NOT run as part of the build or deploy pipeline. The deploy
 * succeeding does not depend on the migration completing. The dual-
 * shape PATCH endpoint keeps the API working for both old and new
 * clients during the rollout window.
 *
 * Usage: npx tsx scripts/migrate-banner-backdrop-shape.ts
 */
import './_load-env'
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import { prisma } from '../src/lib/prisma'
import { runBannerBackdropShapeMigration } from '../src/lib/banner-backdrop-shape-migration'

async function main() {
  await runBannerBackdropShapeMigration({
    findRows: () =>
      prisma.user.findMany({
        where: {
          bannerType: 'BACKDROP',
          NOT: { bannerValue: { startsWith: '{' } },
        },
        select: { id: true, bannerValue: true },
        orderBy: { id: 'asc' },
      }),
    updateRow: async (id, bannerValue) => {
      await prisma.user.update({ where: { id }, data: { bannerValue } })
    },
    log: (m) => console.log(m),
  })

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
