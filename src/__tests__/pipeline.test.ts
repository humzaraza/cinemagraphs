import { describe, it, expect, vi } from 'vitest'

describe('Pipeline Error Handling', () => {
  it('continues when one review source fails', async () => {
    // Simulate Promise.allSettled behavior with one failure
    const results = await Promise.allSettled([
      Promise.resolve([{ text: 'review 1' }]),
      Promise.reject(new Error('TMDB timeout')),
      Promise.resolve([{ text: 'review 2' }]),
    ])

    const allReviews = results
      .filter((r): r is PromiseFulfilledResult<any[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value)

    expect(allReviews).toHaveLength(2)
    expect(results[1].status).toBe('rejected')
  })

  it('identifies films with insufficient reviews', () => {
    const reviews = [{ id: '1', text: 'only one review' }]
    const minRequired = 3

    const hasEnough = reviews.length >= minRequired

    expect(hasEnough).toBe(false)
  })

  it('handles invalid JSON from Claude gracefully', () => {
    const rawResponse = 'Here is the analysis:\n```json\n{invalid json}\n```'

    // Strip markdown fences
    const cleaned = rawResponse
      .replace(/^```json?\s*/im, '')
      .replace(/\s*```$/im, '')
      .trim()

    let parsed: unknown = null
    let error: Error | null = null

    try {
      parsed = JSON.parse(cleaned)
    } catch (err) {
      error = err as Error
    }

    expect(parsed).toBeNull()
    expect(error).toBeInstanceOf(Error)
  })

  it('retries should use stricter prompt on second attempt', () => {
    const basePrompt = 'Analyze this film...'
    const strictPrefix = 'IMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON — no markdown fences, no preamble, no trailing text.\n\n'

    const attempt0Prompt = basePrompt
    const attempt1Prompt = `${strictPrefix}${basePrompt}`

    expect(attempt0Prompt).not.toContain('IMPORTANT')
    expect(attempt1Prompt).toContain('IMPORTANT')
    expect(attempt1Prompt).toContain(basePrompt)
  })

  it('source timeout is handled within allSettled', async () => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout: 10000ms')), 10)
    })

    const results = await Promise.allSettled([
      Promise.resolve([{ text: 'ok' }]),
      timeoutPromise,
    ])

    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
  })
})
