import dotenv from 'dotenv'
// Load .env.local first so NEON_API_KEY / NEON_ORG_ID / DATABASE_URL are
// available before createTestBranch runs. Falls back to .env so a CI env
// that only has one of them still works.
dotenv.config({ path: '.env.local' })
dotenv.config()

// The Prisma Neon adapter uses @neondatabase/serverless's Pool under the hood,
// which needs a WebSocket implementation when running in Node (in a Vercel
// Edge runtime the native WebSocket is used). The existing one-off scripts
// do the same thing — see e.g. scripts/backfill-last-review-count.ts.
import ws from 'ws'
import { neonConfig } from '@neondatabase/serverless'
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// ── Prisma mock plumbing ────────────────────────────────────────────────────
//
// The production helper (src/lib/sentiment-beat-lock.ts) imports a singleton
// `prisma` from `@/lib/prisma`, which is created against the production
// DATABASE_URL at module load. For the integration tests we need every call
// made by the helper to hit a throwaway Neon branch instead, without mutating
// process.env. Solution: vi.mock the module with a Proxy that forwards every
// property access to a test PrismaClient we instantiate inside beforeAll
// (after the Neon branch is ready).
const refs = vi.hoisted(() => {
  const state: { testPrisma: unknown } = { testPrisma: null }
  const prismaProxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (!state.testPrisma) {
          throw new Error(
            `integration test prisma client accessed (.${String(prop)}) before beforeAll initialised it`
          )
        }
        const value = (state.testPrisma as Record<PropertyKey, unknown>)[prop as string]
        if (typeof value === 'function') {
          return (value as (...args: unknown[]) => unknown).bind(state.testPrisma)
        }
        return value
      },
    }
  )
  return { state, prismaProxy }
})

vi.mock('@/lib/prisma', () => ({ prisma: refs.prismaProxy }))

// Imports below this line pick up the mocked prisma module.
import { PrismaClient } from '@/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import {
  forceOverwriteSentimentGraph,
  safeWriteSentimentGraph,
} from '@/lib/sentiment-beat-lock'
import { maybeBlendAndUpdate } from '@/lib/review-blender'
import type { SentimentDataPoint } from '@/lib/types'
import {
  createTestBranch,
  deleteTestBranch,
} from '../../../scripts/integration/neon-test-branch'
import { seedTestFilm } from '../../../scripts/integration/seed-test-film'

function beat(
  label: string,
  timeStart: number,
  score: number,
  extra: Partial<SentimentDataPoint> = {}
): SentimentDataPoint {
  return {
    label,
    timeStart,
    timeEnd: timeStart + 10,
    timeMidpoint: timeStart + 5,
    score,
    confidence: 'medium',
    reviewEvidence: `evidence for ${label}`,
    ...extra,
  }
}

describe.sequential('beat-lock integration tests (real Neon branch)', () => {
  let branchInfo: { branchId: string; branchName: string; databaseUrl: string } | null = null
  let testPrisma: PrismaClient | null = null

  beforeAll(async () => {
    branchInfo = await createTestBranch({ testName: 'beat-lock' })
    console.log(
      `[integration] Neon branch ready — name=${branchInfo.branchName} id=${branchInfo.branchId}`
    )
    const adapter = new PrismaNeon({ connectionString: branchInfo.databaseUrl })
    testPrisma = new PrismaClient({ adapter })
    refs.state.testPrisma = testPrisma
  }, 120_000)

  afterAll(async () => {
    try {
      if (testPrisma) {
        await testPrisma.$disconnect()
      }
    } finally {
      refs.state.testPrisma = null
      if (branchInfo) {
        console.log(`[integration] Deleting Neon branch ${branchInfo.branchId}`)
        await deleteTestBranch(branchInfo.branchId)
      }
    }
  }, 60_000)

  it('INT-A: concurrent writes on same filmId serialize correctly', async () => {
    if (!testPrisma) throw new Error('testPrisma not initialised')
    const existing: SentimentDataPoint[] = [
      beat('Opening', 0, 5),
      beat('Rising', 10, 6),
      beat('Climax', 20, 7),
    ]
    const { filmId } = await seedTestFilm(testPrisma, existing)

    const writeA = {
      filmId,
      incomingDataPoints: [
        beat('Opening', 0, 1),
        beat('Rising', 10, 2),
        beat('Climax', 20, 3),
      ],
      otherFields: {
        overallScore: 2,
        anchoredFrom: 'writer-a',
        reviewCount: 1,
        sourcesUsed: ['a'] as string[],
      },
      callerPath: 'test' as const,
    }
    const writeB = {
      filmId,
      incomingDataPoints: [
        beat('Opening', 0, 8),
        beat('Rising', 10, 9),
        beat('Climax', 20, 10),
      ],
      otherFields: {
        overallScore: 9,
        anchoredFrom: 'writer-b',
        reviewCount: 1,
        sourcesUsed: ['b'] as string[],
      },
      callerPath: 'test' as const,
    }

    const [resA, resB] = await Promise.all([
      safeWriteSentimentGraph(writeA),
      safeWriteSentimentGraph(writeB),
    ])

    expect(resA.status).toBe('written')
    expect(resB.status).toBe('written')

    const finalRow = await testPrisma.sentimentGraph.findUniqueOrThrow({ where: { filmId } })
    const finalPoints = finalRow.dataPoints as unknown as SentimentDataPoint[]
    expect(finalPoints).toHaveLength(3)

    const finalScores = finalPoints.map((p) => p.score)
    const scoresA = writeA.incomingDataPoints.map((p) => p.score)
    const scoresB = writeB.incomingDataPoints.map((p) => p.score)

    const matchesA = finalScores.every((s, i) => s === scoresA[i])
    const matchesB = finalScores.every((s, i) => s === scoresB[i])
    expect(matchesA || matchesB).toBe(true)
    // No interleaved result — must be exactly one winner.
    expect(matchesA && matchesB).toBe(false)

    const driftLogs = await testPrisma.sentimentGraphDriftLog.findMany({ where: { filmId } })
    expect(driftLogs).toEqual([])
  }, 60_000)

  it('INT-B: drift log row actually persists when an extra incoming label is dropped', async () => {
    if (!testPrisma) throw new Error('testPrisma not initialised')
    const existing: SentimentDataPoint[] = [
      beat('Opening', 0, 5),
      beat('Rising', 10, 6),
      beat('Climax', 20, 7),
    ]
    const { filmId } = await seedTestFilm(testPrisma, existing)

    const result = await safeWriteSentimentGraph({
      filmId,
      incomingDataPoints: [
        beat('Opening', 0, 2),
        beat('Rising', 10, 3),
        beat('Climax', 20, 4),
        beat('ExtraLabel', 30, 5),
      ],
      otherFields: {
        overallScore: 3.5,
        anchoredFrom: 'drift-test',
        reviewCount: 1,
        sourcesUsed: ['x'] as string[],
      },
      callerPath: 'test',
    })

    expect(result.status).toBe('written_with_drops')
    expect(result.droppedIncomingLabels).toEqual(['ExtraLabel'])

    const finalRow = await testPrisma.sentimentGraph.findUniqueOrThrow({ where: { filmId } })
    const finalPoints = finalRow.dataPoints as unknown as SentimentDataPoint[]
    expect(finalPoints).toHaveLength(3)
    expect(finalPoints.map((p) => p.label)).toEqual(['Opening', 'Rising', 'Climax'])

    const driftLogs = await testPrisma.sentimentGraphDriftLog.findMany({ where: { filmId } })
    expect(driftLogs).toHaveLength(1)
    const [log] = driftLogs
    expect(log.filmId).toBe(filmId)
    expect(log.existingBeatCount).toBe(3)
    expect(log.incomingBeatCount).toBe(4)
    expect(log.action).toBe('write_accepted_with_drops')

    const mismatched = log.mismatchedLabels as unknown as Array<{
      incoming: string
      reason: string
    }>
    const dropped = mismatched.find((m) => m.reason === 'not_in_existing')
    expect(dropped).toBeDefined()
    expect(dropped?.incoming).toBe('ExtraLabel')
  }, 60_000)

  it('INT-C: force-overwrite replaces labels and does not write a drift log', async () => {
    if (!testPrisma) throw new Error('testPrisma not initialised')
    const existing: SentimentDataPoint[] = [
      beat('Opening', 0, 5),
      beat('Rising', 10, 6),
      beat('Climax', 20, 7),
    ]
    const { filmId } = await seedTestFilm(testPrisma, existing)

    await forceOverwriteSentimentGraph({
      filmId,
      dataPoints: [beat('NewLabelA', 0, 2), beat('NewLabelB', 10, 3)],
      otherFields: {
        overallScore: 2.5,
        anchoredFrom: 'force-test',
        reviewCount: 1,
        sourcesUsed: ['x'],
      },
      callerPath: 'test',
    })

    const finalRow = await testPrisma.sentimentGraph.findUniqueOrThrow({ where: { filmId } })
    const finalPoints = finalRow.dataPoints as unknown as SentimentDataPoint[]
    expect(finalPoints).toHaveLength(2)
    expect(finalPoints.map((p) => p.label)).toEqual(['NewLabelA', 'NewLabelB'])

    const driftLogs = await testPrisma.sentimentGraphDriftLog.findMany({ where: { filmId } })
    expect(driftLogs).toEqual([])
  }, 60_000)

  it('INT-D: review-blender end-to-end raises beat scores without writing a drift log', async () => {
    if (!testPrisma) throw new Error('testPrisma not initialised')
    // Seed a film with no graph, then create the graph manually so we can pin
    // overallScore=5.0 — seedTestFilm hardcodes 7 otherwise.
    const { filmId } = await seedTestFilm(testPrisma)
    const initialBeats: SentimentDataPoint[] = [
      beat('Opening', 0, 5),
      beat('Rising', 10, 6),
      beat('Climax', 20, 7),
    ]
    await testPrisma.sentimentGraph.create({
      data: {
        filmId,
        overallScore: 5.0,
        anchoredFrom: 'integration-test-int-d',
        dataPoints: initialBeats as unknown as object,
        reviewCount: 0,
        sourcesUsed: [],
      },
    })

    // The blender requires >=5 approved user reviews to trigger.
    const userIdSuffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
    for (let i = 0; i < 5; i++) {
      await testPrisma.user.create({
        data: {
          id: `int-d-user-${userIdSuffix}-${i}`,
          email: `int-d-user-${userIdSuffix}-${i}@example.com`,
        },
      })
      await testPrisma.userReview.create({
        data: {
          userId: `int-d-user-${userIdSuffix}-${i}`,
          filmId,
          overallRating: 9,
          beatRatings: { Opening: 9, Rising: 9, Climax: 9 } as unknown as object,
          sentiment: 9.0,
          status: 'approved',
        },
      })
    }

    await maybeBlendAndUpdate(filmId)

    const finalRow = await testPrisma.sentimentGraph.findUniqueOrThrow({ where: { filmId } })
    const finalPoints = finalRow.dataPoints as unknown as SentimentDataPoint[]
    expect(finalPoints).toHaveLength(3)
    expect(finalPoints.map((p) => p.label)).toEqual(['Opening', 'Rising', 'Climax'])

    // Each beat score should rise toward the user-review average of 9.
    for (let i = 0; i < initialBeats.length; i++) {
      expect(finalPoints[i].score).toBeGreaterThan(initialBeats[i].score)
    }

    expect(finalRow.overallScore).toBeGreaterThan(5.0)
    expect(finalRow.varianceSource).toBe('blended')

    const driftLogs = await testPrisma.sentimentGraphDriftLog.findMany({ where: { filmId } })
    expect(driftLogs).toEqual([])
  }, 60_000)
})
