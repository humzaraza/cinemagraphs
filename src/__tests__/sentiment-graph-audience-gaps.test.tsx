/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { buildChartData, type AudienceData } from '@/components/SentimentGraph'
import type { SentimentDataPoint } from '@/lib/types'

// The rules under test, mirroring buildBeatOverlay's run semantics in
// lib/beat-overlay.ts: a beat with no audience average is null, never a
// bridge or a critics stand-in; nulls are what make recharts break the teal
// and ivory lines at unrated beats once connectNulls is gone.

function makeBeat(i: number, score: number): SentimentDataPoint {
  return {
    timeStart: i * 10,
    timeEnd: i * 10 + 10,
    timeMidpoint: i * 10 + 5,
    score,
    label: `Beat ${i}`,
    confidence: 'high',
    reviewEvidence: '',
  }
}

// Eight beats so the synthetic 0m origin row is included (threshold is 6).
const beats = [7.0, 7.5, 8.0, 6.5, 5.5, 6.0, 8.5, 9.0].map((s, i) => makeBeat(i, s))

function makeAudienceData(overrides: Partial<AudienceData> = {}): AudienceData {
  return {
    userReviewCount: 6,
    beatAverages: {},
    liveSessionCount: 0,
    reactionScores: [],
    ...overrides,
  }
}

describe('buildChartData: audience series nulls', () => {
  it('yields a null userScore for a beat with no audience average', () => {
    const { chartData } = buildChartData(
      beats,
      makeAudienceData({ beatAverages: { 'Beat 1': 8.0 } }),
    )
    const unrated = chartData.find((row) => row.label === 'Beat 2')!
    expect(unrated.userScore).toBeNull()
  })

  it('keeps the audience average on a rated beat', () => {
    const { chartData } = buildChartData(
      beats,
      makeAudienceData({ beatAverages: { 'Beat 1': 8.0 } }),
    )
    const rated = chartData.find((row) => row.label === 'Beat 1')!
    expect(rated.userScore).toBe(8.0)
  })

  it('gives the origin row no real audience point, only the critics baseline', () => {
    const { chartData, showOrigin } = buildChartData(
      beats,
      makeAudienceData({ beatAverages: { 'Beat 0': 7.0, 'Beat 1': 8.0 } }),
    )
    expect(showOrigin).toBe(true)
    const origin = chartData[0]
    expect(origin.isStart).toBe(true)
    expect(origin.score).toBe(5) // the critics definition stays
    expect(origin.userScore).toBeNull()
    expect(origin.mergedScore).toBeNull()
  })

  it('keeps a run of consecutive rated beats contiguous', () => {
    const { chartData } = buildChartData(
      beats,
      makeAudienceData({
        beatAverages: { 'Beat 2': 7.0, 'Beat 3': 7.5, 'Beat 4': 6.0 },
      }),
    )
    const pattern = chartData.map((row) => (row.userScore != null ? 'rated' : null))
    // origin + beats 0..7; the run at beats 2..4 has no null inside it
    expect(pattern).toEqual([
      null, // origin
      null, // Beat 0
      null, // Beat 1
      'rated', // Beat 2
      'rated', // Beat 3
      'rated', // Beat 4
      null, // Beat 5
      null, // Beat 6
      null, // Beat 7
    ])
  })

  it('leaves an isolated rated beat surrounded by nulls rather than joined', () => {
    const { chartData } = buildChartData(
      beats,
      makeAudienceData({ beatAverages: { 'Beat 3': 9.0, 'Beat 6': 4.0 } }),
    )
    const scores = chartData.map((row) => row.userScore)
    // origin, 0, 1, 2 | 3 | 4, 5 | 6 | 7
    expect(scores).toEqual([null, null, null, null, 9.0, null, null, 4.0, null])
  })
})

describe('buildChartData: merged series exists only where both sources exist', () => {
  it('yields a null mergedScore for a beat with no audience average', () => {
    const { chartData, hasAudienceData } = buildChartData(
      beats,
      makeAudienceData({ beatAverages: { 'Beat 1': 8.0 } }),
    )
    expect(hasAudienceData).toBe(true)
    const unrated = chartData.find((row) => row.label === 'Beat 2')!
    expect(unrated.mergedScore).toBeNull()
  })

  it('computes mergedScore only where both sources exist, with the blend weights', () => {
    // 6 reviews and no live sessions: external 0.4, audience 0.6, reaction 0.
    const { chartData } = buildChartData(
      beats,
      makeAudienceData({ userReviewCount: 6, beatAverages: { 'Beat 1': 8.0 } }),
    )
    const rated = chartData.find((row) => row.label === 'Beat 1')!
    // critics 7.5 * 0.4 + audience 8.0 * 0.6 = 7.8
    expect(rated.mergedScore).toBe(7.8)
    const mergedCount = chartData.filter((row) => row.mergedScore != null).length
    expect(mergedCount).toBe(1)
  })

  it('does not resurrect an unrated beat through a reaction score', () => {
    // 20+ sessions activate the reaction weight, and beat 2 has a reaction
    // bucket, but with no audience average the beat must stay null instead of
    // becoming a critics+reaction blend.
    const { chartData } = buildChartData(
      beats,
      makeAudienceData({
        liveSessionCount: 25,
        beatAverages: { 'Beat 1': 8.0 },
        reactionScores: [{ index: 2, score: 9.0 }],
      }),
    )
    const unrated = chartData.find((row) => row.label === 'Beat 2')!
    expect(unrated.mergedScore).toBeNull()
  })

  it('produces no audience or merged points at all without audience data', () => {
    const { chartData, hasAudienceData } = buildChartData(beats, null)
    expect(hasAudienceData).toBe(false)
    expect(chartData.every((row) => row.userScore === null)).toBe(true)
    expect(chartData.every((row) => row.mergedScore === null)).toBe(true)
  })
})
