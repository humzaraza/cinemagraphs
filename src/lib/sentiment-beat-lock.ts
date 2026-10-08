import type { Prisma } from '@/generated/prisma/client'
import { prisma } from './prisma'
import { logger } from './logger'
import type { SentimentDataPoint } from './types'
import { classifyArcShape } from './arc-classifier'
import { assertMeanWithinTolerance, meanBeatScore, overallScoreFromBeats } from './sentiment-guards'

export const beatLockLogger = logger.child({ module: 'beat-lock' })

// ── overallScore is derived from the beats being written ────────────────────
//
// On every path the headline persisted with a row is the mean of the beats
// that row will hold, rounded to one decimal. A caller-supplied overallScore
// is replaced (callers compute the same thing or, historically, something
// else: an IMDb-anchored model number, a rating-shifted headline, a blended
// sentiment). previousScore stays the caller's responsibility. An empty beat
// list has no mean, so the caller's fields pass through untouched there.

function withDerivedOverallScore<T extends { overallScore?: number }>(
  dataPoints: ReadonlyArray<SentimentDataPoint>,
  otherFields: T
): T {
  if (dataPoints.length === 0) return otherFields
  return { ...otherFields, overallScore: overallScoreFromBeats(dataPoints) }
}

// ── Mean-vs-score guard on the row as written ───────────────────────────────
//
// The generator validates the model's output, but the merge below can keep
// old scores on preserved beats while otherFields carries a new overallScore,
// and other callers (score refresh, review blender) move the headline without
// regenerating beats. So the row that is ABOUT TO BE WRITTEN is checked here,
// on every path, against the overallScore it will carry. A failing write is
// rejected by throwing inside the transaction, so nothing is persisted.

export type MeanDriftWritePath =
  | 'first_write'
  | 'merge'
  | 'replace_unrated'
  | 'lock_disabled'
  | 'force_overwrite'

// The merge only protects something when the film has user beat ratings,
// which are keyed by beat label. Count reviews carrying a non-empty
// beatRatings object; an empty object is not a rating.
async function countBeatRatedReviews(tx: Prisma.TransactionClient, filmId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ rated: number | bigint }>>`
    SELECT count(*)::int AS rated
    FROM "UserReview"
    WHERE "filmId" = ${filmId}
      AND "beatRatings" IS NOT NULL
      AND jsonb_typeof("beatRatings") = 'object'
      AND "beatRatings" <> '{}'::jsonb
  `
  return Number(rows[0]?.rated ?? 0)
}

export class SentimentGraphMeanDriftError extends Error {
  readonly filmId: string
  readonly callerPath: string
  readonly path: MeanDriftWritePath
  readonly mean: number
  readonly overallScore: number
  readonly gap: number
  readonly existingBeatCount: number
  readonly incomingBeatCount: number
  readonly droppedIncomingLabels: string[]
  readonly preservedExistingLabels: string[]

  constructor(params: {
    filmId: string
    callerPath: string
    path: MeanDriftWritePath
    mean: number
    overallScore: number
    gap: number
    existingBeatCount: number
    incomingBeatCount: number
    droppedIncomingLabels: string[]
    preservedExistingLabels: string[]
    cause: string
  }) {
    super(`Sentiment graph write rejected (${params.path}) for ${params.filmId}: ${params.cause}`)
    this.name = 'SentimentGraphMeanDriftError'
    this.filmId = params.filmId
    this.callerPath = params.callerPath
    this.path = params.path
    this.mean = params.mean
    this.overallScore = params.overallScore
    this.gap = params.gap
    this.existingBeatCount = params.existingBeatCount
    this.incomingBeatCount = params.incomingBeatCount
    this.droppedIncomingLabels = params.droppedIncomingLabels
    this.preservedExistingLabels = params.preservedExistingLabels
  }
}

function assertRowWithinTolerance(params: {
  filmId: string
  callerPath: string
  path: MeanDriftWritePath
  dataPoints: SentimentDataPoint[]
  incomingOverallScore: number | undefined
  existingOverallScore: number | null | undefined
  existingBeatCount: number
  incomingBeatCount: number
  droppedIncomingLabels?: string[]
  preservedExistingLabels?: string[]
}): void {
  // The headline the row will carry after this write: the incoming value when
  // the caller supplies one, otherwise the value already on the row.
  const resulting =
    typeof params.incomingOverallScore === 'number'
      ? params.incomingOverallScore
      : typeof params.existingOverallScore === 'number'
        ? params.existingOverallScore
        : null
  // Nothing to compare against (a create without overallScore fails in Prisma
  // anyway) or nothing to average: not a drift, let the write proceed.
  if (resulting === null || params.dataPoints.length === 0) return

  try {
    assertMeanWithinTolerance(params.dataPoints, resulting)
  } catch (err) {
    let mean = Number.NaN
    try {
      mean = meanBeatScore(params.dataPoints)
    } catch {
      // leave NaN: the cause message already names the offending beat
    }
    throw new SentimentGraphMeanDriftError({
      filmId: params.filmId,
      callerPath: params.callerPath,
      path: params.path,
      mean,
      overallScore: resulting,
      gap: Math.abs(mean - resulting),
      existingBeatCount: params.existingBeatCount,
      incomingBeatCount: params.incomingBeatCount,
      droppedIncomingLabels: params.droppedIncomingLabels ?? [],
      preservedExistingLabels: params.preservedExistingLabels ?? [],
      cause: err instanceof Error ? err.message : String(err),
    })
  }
}

// Runs OUTSIDE the rolled-back transaction so the refusal itself is on record
// in the same table the accepted-with-drops writes use. Best-effort: a logging
// failure must not mask the rejection.
async function recordRejectedWrite(err: SentimentGraphMeanDriftError, envLockEnabled: boolean): Promise<void> {
  beatLockLogger.warn(
    {
      filmId: err.filmId,
      callerPath: err.callerPath,
      path: err.path,
      mean: err.mean,
      overallScore: err.overallScore,
      gap: err.gap,
      existingBeatCount: err.existingBeatCount,
      incomingBeatCount: err.incomingBeatCount,
      droppedCount: err.droppedIncomingLabels.length,
      preservedCount: err.preservedExistingLabels.length,
      event: 'rejected_mean_drift',
    },
    'safeWriteSentimentGraph: write rejected, beats drift from overallScore'
  )
  try {
    await prisma.sentimentGraphDriftLog.create({
      data: {
        filmId: err.filmId,
        callerPath: err.callerPath,
        existingBeatCount: err.existingBeatCount,
        incomingBeatCount: err.incomingBeatCount,
        mismatchedLabels: [
          ...err.droppedIncomingLabels.map((label) => ({ incoming: label, reason: 'not_in_existing' })),
          ...err.preservedExistingLabels.map((label) => ({ incoming: label, reason: 'missing_from_incoming' })),
        ] as unknown as Prisma.InputJsonValue,
        action: 'rejected_mean_drift',
        envLockEnabled,
      },
    })
  } catch (logErr) {
    beatLockLogger.error(
      { filmId: err.filmId, error: logErr instanceof Error ? logErr.message : String(logErr) },
      'safeWriteSentimentGraph: could not record rejected write in drift log'
    )
  }
}

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
  | 'cron-refresh-scores'
  | 'admin-analyze'
  | 'user-submission'
  | 'script-batch-analyze'
  | 'script-bulk-regen-hybrid'
  | 'script-backfill-graph-mean'
  | 'script-restore-critic-beats'
  | 'script-fix-runtimes'
  | 'script-test-pipeline'
  | 'script-backfill-wikipedia-beats'
  | 'script-diagnose-film'
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
  // Generation metadata. Set on every generation write (null when the caller
  // did not supply a value); left unchanged by the blender and by a merge
  // that preserved a stored beat the incoming set did not match.
  generationMode?: string | null
  plotSource?: string | null
  modelName?: string | null
  promptVersion?: string | null
  reviewsInPrompt?: number | null
}

const GENERATION_METADATA_KEYS = [
  'generationMode',
  'plotSource',
  'modelName',
  'promptVersion',
  'reviewsInPrompt',
] as const

/**
 * Split the five generation metadata fields off `otherFields`. With
 * `preserve` they are dropped from the write so the row keeps its current
 * values; otherwise each is written as the supplied value, or null when the
 * caller did not supply it.
 */
function withGenerationMetadata(
  otherFields: Record<string, unknown>,
  preserve: boolean
): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...otherFields }
  for (const key of GENERATION_METADATA_KEYS) delete fields[key]
  if (preserve) return fields
  for (const key of GENERATION_METADATA_KEYS) fields[key] = otherFields[key] ?? null
  return fields
}

export interface SafeWriteResult {
  status: 'written' | 'written_with_drops' | 'rejected_lock_violation'
  acceptedBeatCount: number
  droppedIncomingLabels: string[]
  preservedExistingLabels: string[]
  /** Set when the film had no user beat ratings and the incoming beats
   *  replaced the stored ones outright: the old labels that disappeared. */
  replacedExistingLabels?: string[]
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

  try {
    return await safeWriteInTransaction({ filmId, incomingDataPoints, otherFields, callerPath, envLockEnabled })
  } catch (err) {
    if (err instanceof SentimentGraphMeanDriftError) {
      await recordRejectedWrite(err, envLockEnabled)
    }
    throw err
  }
}

async function safeWriteInTransaction(params: {
  filmId: string
  incomingDataPoints: SentimentDataPoint[]
  otherFields: SafeWriteOtherFields
  callerPath: BeatLockCallerPath
  envLockEnabled: boolean
}): Promise<SafeWriteResult> {
  const { filmId, incomingDataPoints, otherFields, callerPath, envLockEnabled } = params

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
    const existingOverallScore = existing?.overallScore

    // Env kill-switch — skip merge + drift log, write incoming as-is. Still
    // run under the same transaction + FOR UPDATE so races stay handled even
    // when the merge is off.
    if (!envLockEnabled) {
      beatLockLogger.warn(
        { filmId, callerPath, envLockEnabled: false, event: 'beat_lock_disabled' },
        'safeWriteSentimentGraph: beat lock disabled via env, writing incoming dataPoints unmodified'
      )
      const fields = withDerivedOverallScore(incomingDataPoints, otherFields)
      assertRowWithinTolerance({
        filmId,
        callerPath,
        path: 'lock_disabled',
        dataPoints: incomingDataPoints,
        incomingOverallScore: fields.overallScore,
        existingOverallScore,
        existingBeatCount,
        incomingBeatCount: incomingDataPoints.length,
      })
      await writeRow(tx, { filmId, existing, dataPoints: incomingDataPoints, otherFields: fields, callerPath })
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
      const fields = withDerivedOverallScore(incomingDataPoints, otherFields)
      assertRowWithinTolerance({
        filmId,
        callerPath,
        path: 'first_write',
        dataPoints: incomingDataPoints,
        incomingOverallScore: fields.overallScore,
        existingOverallScore,
        existingBeatCount,
        incomingBeatCount: incomingDataPoints.length,
      })
      await writeRow(tx, { filmId, existing, dataPoints: incomingDataPoints, otherFields: fields, callerPath })
      return {
        status: 'written',
        acceptedBeatCount: incomingDataPoints.length,
        droppedIncomingLabels: [],
        preservedExistingLabels: [],
      }
    }

    // No user beat ratings on this film: there is nothing the lock could
    // protect, so the incoming beats replace the stored ones outright
    // (labels, timestamps, scores) and the headline is their mean. This is
    // what makes an admin Regenerate actually regenerate. The label churn is
    // still recorded in the drift log for audit.
    const ratedReviews = await countBeatRatedReviews(tx, filmId)
    if (ratedReviews === 0) {
      const fields = withDerivedOverallScore(incomingDataPoints, otherFields)
      assertRowWithinTolerance({
        filmId,
        callerPath,
        path: 'replace_unrated',
        dataPoints: incomingDataPoints,
        incomingOverallScore: fields.overallScore,
        existingOverallScore,
        existingBeatCount,
        incomingBeatCount: incomingDataPoints.length,
      })
      const incomingLabelSet = new Set(incomingDataPoints.map((b) => b.label))
      const existingLabelSet = new Set(existingBeats.map((b) => b.label))
      const newLabels = incomingDataPoints.map((b) => b.label).filter((l) => !existingLabelSet.has(l))
      const replacedExistingLabels = existingBeats.map((b) => b.label).filter((l) => !incomingLabelSet.has(l))
      if (newLabels.length > 0 || replacedExistingLabels.length > 0 || incomingDataPoints.length !== existingBeatCount) {
        await tx.sentimentGraphDriftLog.create({
          data: {
            filmId,
            callerPath,
            existingBeatCount,
            incomingBeatCount: incomingDataPoints.length,
            mismatchedLabels: [
              ...newLabels.map((label) => ({ incoming: label, reason: 'not_in_existing' as const })),
              ...replacedExistingLabels.map((label) => ({ incoming: label, reason: 'missing_from_incoming' as const })),
            ] as unknown as Prisma.InputJsonValue,
            action: 'write_replaced_unrated',
            envLockEnabled: true,
          },
        })
        beatLockLogger.info(
          { filmId, callerPath, existingBeatCount, incomingBeatCount: incomingDataPoints.length, replacedCount: replacedExistingLabels.length },
          'safeWriteSentimentGraph: film has no user beat ratings, incoming beats replace stored beats'
        )
      }
      await writeRow(tx, { filmId, existing, dataPoints: incomingDataPoints, otherFields: fields, callerPath })
      return {
        status: 'written',
        acceptedBeatCount: incomingDataPoints.length,
        droppedIncomingLabels: [],
        preservedExistingLabels: [],
        replacedExistingLabels,
      }
    }

    // Merge path (the film has user beat ratings): existing labels + timestamps are sticky. Scores,
    // confidence, and reviewEvidence update from incoming when labels match.
    const existingByLabel = new Map<string, SentimentDataPoint>()
    for (const beat of existingBeats) existingByLabel.set(beat.label, beat)

    const mergedByLabel = new Map<string, SentimentDataPoint>()
    const droppedIncomingLabels: string[] = []

    for (const incoming of incomingDataPoints) {
      const match = existingByLabel.get(incoming.label)
      if (match) {
        const merged: SentimentDataPoint = {
          label: match.label,
          timeStart: match.timeStart,
          timeEnd: match.timeEnd,
          timeMidpoint: match.timeMidpoint,
          score: incoming.score,
          confidence: incoming.confidence,
          reviewEvidence: incoming.reviewEvidence,
        }
        // Prefer existing labelFull; fall back to incoming (upgrade path for
        // legacy pre-bae4807 rows); preserve absence when neither has one.
        const labelFull = match.labelFull ?? incoming.labelFull
        if (labelFull !== undefined) merged.labelFull = labelFull
        mergedByLabel.set(match.label, merged)
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

    // The merged row is what gets persisted, so its headline is derived from
    // the merged beats: preserved beats keep their old scores and the mean
    // reflects that. The tolerance check below is a backstop only.
    const fields = withDerivedOverallScore(mergedInOrder, otherFields)
    assertRowWithinTolerance({
      filmId,
      callerPath,
      path: 'merge',
      dataPoints: mergedInOrder,
      incomingOverallScore: fields.overallScore,
      existingOverallScore,
      existingBeatCount,
      incomingBeatCount: incomingDataPoints.length,
      droppedIncomingLabels,
      preservedExistingLabels,
    })

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

    // A preserved beat means the row is not purely the incoming generation,
    // so the generation metadata stays as it was.
    await writeRow(tx, {
      filmId,
      existing,
      dataPoints: mergedInOrder,
      otherFields: fields,
      callerPath,
      preserveGenerationMetadata: hasPreserves,
    })

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

  // Headline derived from the beats being written, same as the safe path.
  // otherFields is loosely typed here, so read it back defensively.
  const fields = withDerivedOverallScore(dataPoints, otherFields as Record<string, unknown> & { overallScore?: number })
  const overallScore = typeof fields.overallScore === 'number' ? fields.overallScore : null
  const arcShape = classifyArcShape(dataPoints, overallScore)

  try {
    await forceOverwriteInTransaction({ filmId, dataPoints, otherFields: fields, callerPath, overallScore, arcShape })
  } catch (err) {
    if (err instanceof SentimentGraphMeanDriftError) {
      beatLockLogger.warn(
        { filmId, callerPath, mean: err.mean, overallScore: err.overallScore, gap: err.gap, event: 'rejected_mean_drift' },
        'forceOverwriteSentimentGraph: write rejected, beats drift from overallScore'
      )
    }
    throw err
  }
}

async function forceOverwriteInTransaction(params: {
  filmId: string
  dataPoints: SentimentDataPoint[]
  otherFields: Record<string, unknown>
  callerPath: string
  overallScore: number | null
  arcShape: ReturnType<typeof classifyArcShape>
}): Promise<void> {
  const { filmId, dataPoints, otherFields, callerPath, overallScore, arcShape } = params

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SentimentGraph" WHERE "filmId" = ${filmId} FOR UPDATE`
    const existing = await tx.sentimentGraph.findUnique({ where: { filmId } })
    // A force overwrite persists exactly these beats with exactly this
    // headline, so the same guard applies; it is intentional relabelling,
    // not a licence to write a drifting row.
    assertRowWithinTolerance({
      filmId,
      callerPath,
      path: 'force_overwrite',
      dataPoints,
      incomingOverallScore: overallScore ?? undefined,
      existingOverallScore: existing?.overallScore,
      existingBeatCount: Array.isArray(existing?.dataPoints) ? existing.dataPoints.length : 0,
      incomingBeatCount: dataPoints.length,
    })
    // A force overwrite is always a generation write, so the beats are the
    // new blend base as well.
    const criticDataPoints = dataPoints as unknown as Prisma.InputJsonValue
    const writeFields = withGenerationMetadata(otherFields, false)
    if (existing) {
      const updateData = {
        ...writeFields,
        dataPoints: dataPoints as unknown as Prisma.InputJsonValue,
        criticDataPoints,
        arcShape,
      }
      await tx.sentimentGraph.update({
        where: { filmId },
        data: updateData as Prisma.SentimentGraphUpdateInput,
      })
    } else {
      const createData = {
        ...writeFields,
        filmId,
        dataPoints: dataPoints as unknown as Prisma.InputJsonValue,
        criticDataPoints,
        arcShape,
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
    callerPath: BeatLockCallerPath
    // Merge path only: a stored beat was kept without a matching incoming one.
    preserveGenerationMetadata?: boolean
  }
) {
  const { filmId, existing, dataPoints, otherFields, callerPath } = args
  // The blender never regenerates beats, so it never touches the generation
  // metadata; neither does a merge that kept an unmatched stored beat.
  const preserveGenerationMetadata =
    callerPath === 'review-blender' || args.preserveGenerationMetadata === true
  const writeFields = withGenerationMetadata(
    otherFields as Record<string, unknown>,
    preserveGenerationMetadata
  )
  // Classify from the EXACT dataPoints being written (post-merge in the merge
  // path) and the incoming headline score, so arcShape never desyncs from the
  // beats it describes. This is the single chokepoint every writer funnels
  // through, so every caller gets arcShape populated.
  const arcShape = classifyArcShape(dataPoints, otherFields.overallScore)
  // Every writer except the blender is writing critic beats, so they are
  // also the new blend base. The blender writes the blended view into
  // dataPoints and must leave criticDataPoints alone.
  const criticDataPoints =
    callerPath === 'review-blender' ? {} : { criticDataPoints: dataPoints as unknown as Prisma.InputJsonValue }
  if (existing) {
    const updateData = {
      ...writeFields,
      dataPoints: dataPoints as unknown as Prisma.InputJsonValue,
      ...criticDataPoints,
      arcShape,
    }
    await tx.sentimentGraph.update({
      where: { filmId },
      data: updateData as Prisma.SentimentGraphUpdateInput,
    })
  } else {
    const createData = {
      ...writeFields,
      filmId,
      dataPoints: dataPoints as unknown as Prisma.InputJsonValue,
      ...criticDataPoints,
      arcShape,
    }
    await tx.sentimentGraph.create({
      data: createData as Prisma.SentimentGraphUncheckedCreateInput,
    })
  }
}
