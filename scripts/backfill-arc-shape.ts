/**
 * One-time backfill: populate SentimentGraph.arcShape for existing graphs.
 *
 * Calls the SAME exported classifyArcShape() that the write path uses
 * (src/lib/sentiment-beat-lock.ts), not a reimplementation. One entry point,
 * both callers, so backfilled films and freshly-written films classify
 * identically (same thresholds, same internal timeMidpoint sort).
 *
 * Idempotent: recomputes arcShape from each row's stored dataPoints +
 * overallScore and writes only when the tags changed. Safe to re-run.
 *
 * Verification: run with --dry-run first to preview the tag tally and how many
 * rows would change. After a real run, a second --dry-run should report
 * "0 would change", confirming the backfill applied and is stable. (This sides
 * steps the `prisma db execute` SELECT-output quirk by reading via the client.)
 *
 * GATED: this mutates the shared Neon (prod/preview) database. Do not run
 * without explicit go-ahead.
 *
 * Usage:
 *   npx tsx scripts/backfill-arc-shape.ts --dry-run   # preview, no writes
 *   npx tsx scripts/backfill-arc-shape.ts             # apply
 */
import './_load-env'
import './_neon-ws'

import { prisma } from '../src/lib/prisma'
import { classifyArcShape, type ClassifierBeat } from '../src/lib/arc-classifier'

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  // classifyArcShape returns canonical order and stored tags were written in
  // canonical order, so a positional compare is sufficient.
  return a.length === b.length && a.every((t, i) => t === b[i])
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  const graphs = await prisma.sentimentGraph.findMany({
    select: {
      id: true,
      dataPoints: true,
      overallScore: true,
      arcShape: true,
    },
  })

  console.log(
    `[backfill-arc-shape] ${graphs.length} sentiment graphs${dryRun ? ' (DRY RUN, no writes)' : ''}`,
  )

  const tally: Record<string, number> = {}
  let tagged = 0
  let changed = 0
  let unchanged = 0
  let failed = 0

  for (let i = 0; i < graphs.length; i++) {
    const g = graphs[i]
    const beats = Array.isArray(g.dataPoints)
      ? (g.dataPoints as unknown as ClassifierBeat[])
      : []
    const arcShape = classifyArcShape(beats, g.overallScore)

    for (const t of arcShape) tally[t] = (tally[t] ?? 0) + 1
    if (arcShape.length > 0) tagged++

    if (sameTags(arcShape, g.arcShape)) {
      unchanged++
    } else if (dryRun) {
      changed++
    } else {
      try {
        await prisma.sentimentGraph.update({
          where: { id: g.id },
          data: { arcShape },
        })
        changed++
      } catch (err) {
        failed++
        const message = err instanceof Error ? err.message : String(err)
        console.error(`  FAILED: graph ${g.id} — ${message}`)
      }
    }

    if ((i + 1) % 200 === 0) console.log(`  processed ${i + 1} of ${graphs.length}`)
  }

  console.log(
    `[backfill-arc-shape] tagged ${tagged}/${graphs.length} films; ` +
      `${changed} ${dryRun ? 'would change' : 'updated'}, ${unchanged} unchanged` +
      (failed > 0 ? `, ${failed} failed` : ''),
  )
  console.log('[backfill-arc-shape] tag tally:', JSON.stringify(tally, null, 2))

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('[backfill-arc-shape] fatal:', err)
  await prisma.$disconnect()
  process.exit(1)
})
