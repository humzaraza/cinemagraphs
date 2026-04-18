import type { Prisma } from '@/generated/prisma/client'
import { prisma } from './prisma'
import { logger } from './logger'
import type { SentimentDataPoint } from './types'

export const beatLockLogger = logger.child({ module: 'beat-lock' })

// ── Env flag ────────────────────────────────────────────────────────────────
//
// Fail-safe: anything other than the literal string "false" means the lock is
// on. An unset var means the lock is on. This is intentional — the kill switch
// should require an explicit, typo-resistant opt-out.

export function isBeatLockEnabled(): boolean {
  const value = process.env.SENTIMENT_BEAT_LOCK_ENABLED
  if (value === undefined) return true
  if (value === 'false') return false
  return true
}

// ── Caller enum ─────────────────────────────────────────────────────────────
//
// `callerPath` feeds the drift log. Keep it a closed union so grepping for a
// specific caller stays easy and so nobody logs a stack trace in as a
// "callerPath".

export type BeatLockCallerPath =
  | 'review-blender'
  | 'cron-analyze'
  | 'admin-analyze'
  | 'script-batch-analyze'
  | 'script-test-pipeline'
  | 'script-backfill-wikipedia-beats'
  | 'test'

// ── Public types ────────────────────────────────────────────────────────────

export interface SafeWriteOtherFields {
  overallScore?: number
  previousScore?: number | null
  anchoredFrom?: string
  varianceSource?: string
  peakMoment?: unknown
  lowestMoment?: unknown
  biggestSwing?: string | null
  summary?: string | null
  reviewCount?: number
  sourcesUsed?: string[]
  generatedAt?: Date
  version?: number
  reviewHash?: string | null
}

export interface SafeWriteResult {
  status: 'written' | 'written_with_drops' | 'rejected_lock_violation'
  acceptedBeatCount: number
  droppedIncomingLabels: string[]
  preservedExistingLabels: string[]
}

type MismatchReason = 'not_in_existing' | 'missing_from_incoming'

interface MismatchedLabel {
  incoming: string
  reason: MismatchReason
}

// ── Safe write ──────────────────────────────────────────────────────────────

export async function safeWriteSentimentGraph(params: {
  filmId: string
  incomingDataPoints: SentimentDataPoint[]
  otherFields: SafeWriteOtherFields
  callerPath: BeatLockCallerPath
}): Promise<SafeWriteResult> {
  const { filmId, incomingDataPoints, otherFields, callerPath } = params
  const envLockEnabled = isBeatLockEnabled()

  return await prisma.$transaction(async (tx) => {
    // Row-level lock — serializes concurrent writers against the same filmId.
    // Returns 0 rows on the first-ever write for this film; that's fine, the
    // unique(filmId) constraint still protects the subsequent create.
    await tx.$queryRaw`SELECT id FROM "SentimentGraph" WHERE "filmId" = ${filmId} FOR UPDATE`

    const existing = await tx.sentimentGraph.findUnique({ where: { filmId } })
    const existingBeats = existing
      ? (existing.dataPoints as unknown as SentimentDataPoint[])
      : []
    const existingBeatCount = existingBeats.length

    // Env kill-switch — skip merge + drift log, write incoming as-is. Still
    // run under the same transaction + FOR UPDATE so races stay handled even
    // when the merge is off.
    if (!envLockEnabled) {
      beatLockLogger.warn(
        { filmId, callerPath, envLockEnabled: false, event: 'beat_lock_disabled' },
        'safeWriteSentimentGraph: beat lock disabled via env, writing incoming dataPoints unmodified'
      )
      await writeRow(tx, { filmId, existing, dataPoints: incomingDataPoints, otherFields })
      return {
        status: 'written',
        acceptedBeatCount: incomingDataPoints.length,
        droppedIncomingLabels: [],
        preservedExistingLabels: [],
      }
    }

    // First-ever write path (no row OR row with empty dataPoints). Nothing to
    // compare against, so no drift log; incoming labels + timestamps stand.
    if (existingBeatCount === 0) {
      await writeRow(tx, { filmId, existing, dataPoints: incomingDataPoints, otherFields })
      return {
        status: 'written',
        acceptedBeatCount: incomingDataPoints.length,
        droppedIncomingLabels: [],
        preservedExistingLabels: [],
      }
    }

    // Merge path — existing labels + timestamps are sticky. Scores,
    // confidence, and reviewEvidence update from incoming when labels match.
    const existingByLabel = new Map<string, SentimentDataPoint>()
    for (const beat of existingBeats) existingByLabel.set(beat.label, beat)

    const mergedByLabel = new Map<string, SentimentDataPoint>()
    const droppedIncomingLabels: string[] = []

    for (const incoming of incomingDataPoints) {
      const match = existingByLabel.get(incoming.label)
      if (match) {
        mergedByLabel.set(match.label, {
          label: match.label,
          timeStart: match.timeStart,
          timeEnd: match.timeEnd,
          timeMidpoint: match.timeMidpoint,
          score: incoming.score,
          confidence: incoming.confidence,
          reviewEvidence: incoming.reviewEvidence,
        })
      } else {
        droppedIncomingLabels.push(incoming.label)
      }
    }

    const preservedExistingLabels: string[] = []
    const mergedInOrder: SentimentDataPoint[] = []
    for (const existingBeat of existingBeats) {
      const merged = mergedByLabel.get(existingBeat.label)
      if (merged) {
        mergedInOrder.push(merged)
      } else {
        preservedExistingLabels.push(existingBeat.label)
        mergedInOrder.push(existingBeat)
      }
    }

    const hasDrops = droppedIncomingLabels.length > 0
    const hasPreserves = preservedExistingLabels.length > 0
    const countMismatch = incomingDataPoints.length !== existingBeatCount
    const needDriftLog = hasDrops || hasPreserves || countMismatch

    const action: 'write_accepted' | 'write_accepted_with_drops' = hasDrops
      ? 'write_accepted_with_drops'
      : 'write_accepted'

    if (needDriftLog) {
      const mismatchedLabels: MismatchedLabel[] = [
        ...droppedIncomingLabels.map((label) => ({
          incoming: label,
          reason: 'not_in_existing' as const,
        })),
        ...preservedExistingLabels.map((label) => ({
          incoming: label,
          reason: 'missing_from_incoming' as const,
        })),
      ]

      await tx.sentimentGraphDriftLog.create({
        data: {
          filmId,
          callerPath,
          existingBeatCount,
          incomingBeatCount: incomingDataPoints.length,
          mismatchedLabels: mismatchedLabels as unknown as Prisma.InputJsonValue,
          action,
          envLockEnabled: true,
        },
      })

      beatLockLogger.warn(
        {
          filmId,
          callerPath,
          existingBeatCount,
          incomingBeatCount: incomingDataPoints.length,
          droppedCount: droppedIncomingLabels.length,
          preservedCount: preservedExistingLabels.length,
          action,
        },
        'safeWriteSentimentGraph: beat drift detected'
      )
    }

    await writeRow(tx, { filmId, existing, dataPoints: mergedInOrder, otherFields })

    return {
      status: hasDrops ? 'written_with_drops' : 'written',
      acceptedBeatCount: mergedInOrder.length,
      droppedIncomingLabels,
      preservedExistingLabels,
    }
  })
}

// ── Force overwrite (bulk regeneration scripts only) ────────────────────────

export async function forceOverwriteSentimentGraph(params: {
  filmId: string
  dataPoints: SentimentDataPoint[]
  otherFields: Record<string, unknown>
  callerPath: string
}): Promise<void> {
  const { filmId, dataPoints, otherFields, callerPath } = params

  beatLockLogger.warn(
    { filmId, callerPath, event: 'force_overwrite' },
    'forceOverwriteSentimentGraph: rewriting labels + timestamps without merge'
  )

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SentimentGraph" WHERE "filmId" = ${filmId} FOR UPDATE`
    const existing = await tx.sentimentGraph.findUnique({ where: { filmId } })
    if (existing) {
      const updateData = {
        ...otherFields,
        dataPoints: dataPoints as unknown as Prisma.InputJsonValue,
      }
      await tx.sentimentGraph.update({
        where: { filmId },
        data: updateData as Prisma.SentimentGraphUpdateInput,
      })
    } else {
      const createData = {
        ...otherFields,
        filmId,
        dataPoints: dataPoints as unknown as Prisma.InputJsonValue,
      }
      await tx.sentimentGraph.create({
        data: createData as Prisma.SentimentGraphUncheckedCreateInput,
      })
    }
  })
}

// ── Internals ───────────────────────────────────────────────────────────────

async function writeRow(
  tx: Prisma.TransactionClient,
  args: {
    filmId: string
    existing: { id: string } | null
    dataPoints: SentimentDataPoint[]
    otherFields: SafeWriteOtherFields
  }
) {
  const { filmId, existing, dataPoints, otherFields } = args
  if (existing) {
    const updateData = {
      ...otherFields,
      dataPoints: dataPoints as unknown as Prisma.InputJsonValue,
    }
    await tx.sentimentGraph.update({
      where: { filmId },
      data: updateData as Prisma.SentimentGraphUpdateInput,
    })
  } else {
    const createData = {
      ...otherFields,
      filmId,
      dataPoints: dataPoints as unknown as Prisma.InputJsonValue,
    }
    await tx.sentimentGraph.create({
      data: createData as Prisma.SentimentGraphUncheckedCreateInput,
    })
  }
}
