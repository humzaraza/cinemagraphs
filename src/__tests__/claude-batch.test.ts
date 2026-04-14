import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the args passed to the Anthropic SDK so each test can assert on
// the request shape (cache_control, model, etc.) without hitting the network.
const mockBatchesCreate = vi.fn()
const mockBatchesRetrieve = vi.fn()
const mockBatchesResults = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  // Default export is a class. The library code does `new Anthropic({...})`
  // and reaches `.messages.batches.{create,retrieve,results}`.
  class MockAnthropic {
    messages = {
      batches: {
        create: (...args: unknown[]) => mockBatchesCreate(...args),
        retrieve: (...args: unknown[]) => mockBatchesRetrieve(...args),
        results: (...args: unknown[]) => mockBatchesResults(...args),
      },
    }
  }
  return { default: MockAnthropic }
})

vi.mock('@/lib/logger', () => ({
  pipelineLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// A valid SentimentGraphData JSON the parser will accept (≥10 data points).
function validGraphJson(): string {
  const dataPoints = Array.from({ length: 14 }, (_, i) => ({
    timeStart: i * 8,
    timeEnd: (i + 1) * 8,
    timeMidpoint: i * 8 + 4,
    score: 7,
    label: `Segment ${i + 1}`,
    confidence: 'medium',
    reviewEvidence: 'Reviewers liked this section.',
  }))
  return JSON.stringify({
    film: 'Test Film',
    anchoredFrom: 'IMDb 7.5',
    dataPoints,
    overallSentiment: 7,
    peakMoment: { label: 'High', score: 9, time: 60 },
    lowestMoment: { label: 'Low', score: 5, time: 20 },
    biggestSentimentSwing: 'Mid-film tonal shift',
    summary: 'A solid run with a strong middle.',
    // Server-controlled fields the parser overwrites; values here don't matter.
    sources: ['will-be-overwritten'],
    varianceSource: 'external_only',
    reviewCount: 999,
    generatedAt: '2024-01-01T00:00:00Z',
  })
}

// Build a mock async-iterable batch results decoder for fetchBatchResults.
// Mirrors the shape of `anthropic.messages.batches.results(id)`.
function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item
    },
  }
}

describe('analyzeSentimentBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('submits requests with cache_control on the system prompt', async () => {
    mockBatchesCreate.mockResolvedValueOnce({
      id: 'batch_abc',
      created_at: '2024-01-01T00:00:00Z',
    })

    const { analyzeSentimentBatch, SENTIMENT_MODEL, SENTIMENT_MAX_TOKENS } = await import(
      '@/lib/claude'
    )

    const result = await analyzeSentimentBatch([
      { customId: 'film-1', system: 'system A', user: 'user A' },
      { customId: 'film-2', system: 'system B', user: 'user B' },
    ])

    expect(result).toEqual({ batchId: 'batch_abc', submittedAt: '2024-01-01T00:00:00Z' })
    expect(mockBatchesCreate).toHaveBeenCalledTimes(1)

    const callArgs = mockBatchesCreate.mock.calls[0][0]
    expect(callArgs.requests).toHaveLength(2)

    for (const req of callArgs.requests) {
      // Stable model + token cap come from the constants in claude.ts.
      expect(req.params.model).toBe(SENTIMENT_MODEL)
      expect(req.params.max_tokens).toBe(SENTIMENT_MAX_TOKENS)

      // cache_control on the system block is the whole point of Phase 3.
      expect(Array.isArray(req.params.system)).toBe(true)
      expect(req.params.system).toHaveLength(1)
      expect(req.params.system[0].type).toBe('text')
      expect(req.params.system[0].cache_control).toEqual({ type: 'ephemeral' })

      // User content goes through as a single user message.
      expect(req.params.messages).toEqual([
        { role: 'user', content: expect.any(String) },
      ])
    }

    // Custom IDs round-trip so fetchBatchResults can match results back to films.
    expect(callArgs.requests[0].custom_id).toBe('film-1')
    expect(callArgs.requests[1].custom_id).toBe('film-2')
  })

  it('uses the locked sonnet-4 model identifier', async () => {
    const { SENTIMENT_MODEL } = await import('@/lib/claude')
    // The model is intentionally pinned — we should not silently drift.
    expect(SENTIMENT_MODEL).toBe('claude-sonnet-4-20250514')
  })

  it('throws when called with no jobs', async () => {
    const { analyzeSentimentBatch } = await import('@/lib/claude')
    await expect(analyzeSentimentBatch([])).rejects.toThrow(/no jobs/)
    expect(mockBatchesCreate).not.toHaveBeenCalled()
  })
})

describe('getBatchStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('flattens the SDK response into our shape', async () => {
    mockBatchesRetrieve.mockResolvedValueOnce({
      processing_status: 'in_progress',
      request_counts: {
        processing: 3,
        succeeded: 1,
        errored: 0,
        canceled: 0,
        expired: 0,
      },
    })

    const { getBatchStatus } = await import('@/lib/claude')
    const status = await getBatchStatus('batch_abc')

    expect(status.processingStatus).toBe('in_progress')
    expect(status.requestCounts).toEqual({
      processing: 3,
      succeeded: 1,
      errored: 0,
      canceled: 0,
      expired: 0,
    })
  })
})

describe('fetchBatchResults', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses succeeded entries and captures usage', async () => {
    mockBatchesResults.mockResolvedValueOnce(
      asyncIter([
        {
          custom_id: 'film-1',
          result: {
            type: 'succeeded',
            message: {
              content: [{ type: 'text', text: validGraphJson() }],
              usage: {
                input_tokens: 1000,
                output_tokens: 500,
                cache_read_input_tokens: 800,
                cache_creation_input_tokens: 200,
              },
            },
          },
        },
      ])
    )

    const { fetchBatchResults } = await import('@/lib/claude')
    const ctx = new Map([['film-1', { reviewCount: 12, sources: ['tmdb', 'imdb'] }]])
    const results = await fetchBatchResults('batch_abc', ctx)

    expect(results).toHaveLength(1)
    const entry = results[0]
    expect(entry.outcome).toBe('succeeded')
    expect(entry.customId).toBe('film-1')
    expect(entry.data?.dataPoints.length).toBeGreaterThanOrEqual(10)
    // Server-controlled fields get coerced onto the parsed graph.
    expect(entry.data?.reviewCount).toBe(12)
    expect(entry.data?.sources).toEqual(['tmdb', 'imdb'])
    expect(entry.data?.varianceSource).toBe('external_only')
    expect(entry.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 200,
    })
  })

  it('marks parse failures as errored without throwing', async () => {
    mockBatchesResults.mockResolvedValueOnce(
      asyncIter([
        {
          custom_id: 'film-bad',
          result: {
            type: 'succeeded',
            message: {
              content: [{ type: 'text', text: 'not actually json {{' }],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
        },
      ])
    )

    const { fetchBatchResults } = await import('@/lib/claude')
    const ctx = new Map([['film-bad', { reviewCount: 0, sources: [] }]])
    const results = await fetchBatchResults('batch_abc', ctx)

    expect(results).toHaveLength(1)
    expect(results[0].outcome).toBe('errored')
    expect(results[0].error).toMatch(/Parse failure/)
    // Usage should still be captured so we don't undercount cost.
    expect(results[0].usage?.inputTokens).toBe(10)
  })

  it('captures errored entries with the error message', async () => {
    mockBatchesResults.mockResolvedValueOnce(
      asyncIter([
        {
          custom_id: 'film-err',
          result: {
            type: 'errored',
            error: { error: { message: 'overloaded_error' } },
          },
        },
      ])
    )

    const { fetchBatchResults } = await import('@/lib/claude')
    const results = await fetchBatchResults('batch_abc', new Map())

    expect(results[0].outcome).toBe('errored')
    expect(results[0].error).toBe('overloaded_error')
    expect(results[0].usage).toBeUndefined()
  })

  it('reports canceled and expired outcomes', async () => {
    mockBatchesResults.mockResolvedValueOnce(
      asyncIter([
        { custom_id: 'film-cx', result: { type: 'canceled' } },
        { custom_id: 'film-ex', result: { type: 'expired' } },
      ])
    )

    const { fetchBatchResults } = await import('@/lib/claude')
    const results = await fetchBatchResults('batch_abc', new Map())

    expect(results.map((r) => [r.customId, r.outcome])).toEqual([
      ['film-cx', 'canceled'],
      ['film-ex', 'expired'],
    ])
  })

  it('falls back to empty context when customId is unknown', async () => {
    // The cron persists a context map keyed by filmId; if the SDK ever returned
    // an entry for a customId we don't know about, we shouldn't crash.
    mockBatchesResults.mockResolvedValueOnce(
      asyncIter([
        {
          custom_id: 'film-unknown',
          result: {
            type: 'succeeded',
            message: {
              content: [{ type: 'text', text: validGraphJson() }],
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
        },
      ])
    )

    const { fetchBatchResults } = await import('@/lib/claude')
    const results = await fetchBatchResults('batch_abc', new Map())

    expect(results[0].outcome).toBe('succeeded')
    expect(results[0].data?.reviewCount).toBe(0)
    expect(results[0].data?.sources).toEqual([])
  })
})

describe('estimateSentimentCost', () => {
  it('charges full price for sync calls', async () => {
    const { estimateSentimentCost } = await import('@/lib/claude')
    // 1M input tokens @ $3/MTok = $3.00
    const cost = estimateSentimentCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      { isBatch: false }
    )
    expect(cost).toBeCloseTo(3.0, 6)
  })

  it('halves the price for batch calls', async () => {
    const { estimateSentimentCost } = await import('@/lib/claude')
    // 1M input tokens @ $3/MTok with 50% batch discount = $1.50
    const cost = estimateSentimentCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      { isBatch: true }
    )
    expect(cost).toBeCloseTo(1.5, 6)
  })

  it('charges output tokens at $15/MTok (sync)', async () => {
    const { estimateSentimentCost } = await import('@/lib/claude')
    // 1M output tokens @ $15/MTok = $15.00
    const cost = estimateSentimentCost(
      {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      { isBatch: false }
    )
    expect(cost).toBeCloseTo(15.0, 6)
  })

  it('charges cache reads at the deeply-discounted $0.30/MTok rate', async () => {
    const { estimateSentimentCost } = await import('@/lib/claude')
    // 1M cache-read tokens @ $0.30/MTok = $0.30 (sync)
    const cost = estimateSentimentCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
      },
      { isBatch: false }
    )
    expect(cost).toBeCloseTo(0.3, 6)
  })

  it('charges cache writes at the $3.75/MTok rate (1.25× input)', async () => {
    const { estimateSentimentCost } = await import('@/lib/claude')
    // 1M cache-creation tokens @ $3.75/MTok = $3.75 (sync)
    const cost = estimateSentimentCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
      },
      { isBatch: false }
    )
    expect(cost).toBeCloseTo(3.75, 6)
  })

  it('combines all four token classes correctly under batch pricing', async () => {
    const { estimateSentimentCost } = await import('@/lib/claude')
    // input  500k → 500k/1M * 3 * 0.5  = 0.75
    // output 100k → 100k/1M * 15 * 0.5 = 0.75
    // c-read 800k → 800k/1M * 0.3 * 0.5 = 0.12
    // c-write 200k → 200k/1M * 3.75 * 0.5 = 0.375
    // total = 1.995
    const cost = estimateSentimentCost(
      {
        inputTokens: 500_000,
        outputTokens: 100_000,
        cacheReadInputTokens: 800_000,
        cacheCreationInputTokens: 200_000,
      },
      { isBatch: true }
    )
    expect(cost).toBeCloseTo(1.995, 6)
  })

  it('returns 0 for empty usage', async () => {
    const { estimateSentimentCost } = await import('@/lib/claude')
    const cost = estimateSentimentCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      { isBatch: true }
    )
    expect(cost).toBe(0)
  })
})

describe('sumUsage', () => {
  it('sums an iterable of usage totals field-by-field', async () => {
    const { sumUsage } = await import('@/lib/claude')
    const totals = sumUsage([
      {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
      },
      {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
      {
        inputTokens: 100,
        outputTokens: 200,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 400,
      },
    ])
    expect(totals).toEqual({
      inputTokens: 111,
      outputTokens: 222,
      cacheReadInputTokens: 333,
      cacheCreationInputTokens: 444,
    })
  })

  it('returns zeros for an empty iterable', async () => {
    const { sumUsage } = await import('@/lib/claude')
    expect(sumUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  })
})
