/**
 * Delete the SentimentGraph rows for specific films and invalidate their
 * caches. Film, Review, and UserReview rows are untouched.
 *
 * Meant for graphs that should never have existed: films with no release
 * date (or a future one) whose "reviews" belong to other films with similar
 * titles. The script refuses a film that has a past release date unless
 * --force is given, so a typo in --film-ids cannot delete a real graph.
 *
 * --dry-run prints what would be deleted. --expect-host is required.
 *
 * Usage:
 *   DATABASE_URL='<plain-shadow pooled string>' npx tsx scripts/cleanup/delete-graphs-by-film.ts \
 *     --film-ids cmnyo7th9019p04jybbfxz449,cmnyokh7u01qu04jy016ii18m --dry-run --expect-host plain-shadow
 *   ... --commit --expect-host plain-shadow
 */
import '../_load-env'
import '../_neon-ws'

import { prisma } from '../../src/lib/prisma'
import { invalidateFilmCache, invalidateHomepageCache } from '../../src/lib/cache'

interface Args {
  dryRun: boolean
  commit: boolean
  expectHost: string
  filmIds: string[]
  force: boolean
}

function parseArgs(argv: string[]): Args {
  let dryRun = false
  let commit = false
  let force = false
  let expectHost: string | null = null
  let filmIds: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--commit') commit = true
    else if (a === '--force') force = true
    else if (a === '--expect-host') {
      expectHost = argv[++i] ?? null
      if (!expectHost) throw new Error('--expect-host requires a substring')
    } else if (a === '--film-ids') {
      const raw = argv[++i]
      if (!raw) throw new Error('--film-ids requires a comma-separated list')
      filmIds = raw.split(',').map((s) => s.trim()).filter(Boolean)
    } else throw new Error(`Unknown argument: ${a}`)
  }
  if (!dryRun && !commit) throw new Error('Must pass --dry-run or --commit')
  if (dryRun && commit) throw new Error('Cannot pass both --dry-run and --commit')
  if (!expectHost) throw new Error('--expect-host <substring> is required (production is plain-shadow)')
  if (filmIds.length === 0) throw new Error('--film-ids is required')
  return { dryRun, commit, expectHost, filmIds, force }
}

function databaseHost(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  try {
    return new URL(url).host
  } catch {
    return '<unparseable DATABASE_URL>'
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const host = databaseHost()
  console.log(`[db] host=${host}`)
  if (!host.includes(args.expectHost)) {
    console.error(`[db] host does not contain "${args.expectHost}"; aborting before any read or write`)
    process.exit(1)
  }
  console.log(`delete-graphs-by-film: ${args.dryRun ? 'DRY RUN (no writes)' : 'COMMIT'}`)

  const films = await prisma.film.findMany({
    where: { id: { in: args.filmIds } },
    select: {
      id: true,
      title: true,
      releaseDate: true,
      sentimentGraph: { select: { id: true, reviewCount: true, overallScore: true, generatedAt: true, version: true } },
    },
  })
  const now = new Date()
  const missing = args.filmIds.filter((id) => !films.some((f) => f.id === id))
  for (const id of missing) console.log(`  ? ${id}: no such film`)

  const targets: typeof films = []
  for (const f of films) {
    const release = f.releaseDate ? f.releaseDate.toISOString().slice(0, 10) : 'none'
    const released = f.releaseDate !== null && f.releaseDate <= now
    if (!f.sentimentGraph) {
      console.log(`  - ${f.id} "${f.title}" release=${release}: no graph, nothing to delete`)
      continue
    }
    const g = f.sentimentGraph
    const line = `${f.id} "${f.title}" release=${release} graph=${g.id} score=${g.overallScore} reviews=${g.reviewCount} v${g.version} generated=${g.generatedAt.toISOString().slice(0, 10)}`
    if (released && !args.force) {
      console.log(`  ! ${line}: film IS released; refusing without --force`)
      continue
    }
    console.log(`  x ${line}: will delete`)
    targets.push(f)
  }

  if (args.dryRun) {
    console.log(`\nDry run complete. Would delete ${targets.length} graph(s). No writes.`)
    await prisma.$disconnect()
    return
  }

  let deleted = 0
  for (const f of targets) {
    const result = await prisma.sentimentGraph.deleteMany({ where: { filmId: f.id } })
    deleted += result.count
    await invalidateFilmCache(f.id).catch((err) =>
      console.warn(`  [cache] invalidate failed for ${f.id}: ${err instanceof Error ? err.message : err}`)
    )
    console.log(`  ✓ "${f.title}": deleted ${result.count} graph row(s), cache invalidated`)
  }
  await invalidateHomepageCache().catch(() => {})

  console.log(`\n=== DONE ===  deleted ${deleted} graph(s) for ${targets.length} film(s)`)
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('Fatal:', err)
  try {
    await prisma.$disconnect()
  } catch {
    // ignore
  }
  process.exit(1)
})
