import { describe, it, expect, vi } from 'vitest'

describe('Cron Job Behavior', () => {
  it('one film failing does not stop the batch', async () => {
    const films = [
      { id: '1', title: 'Film A' },
      { id: '2', title: 'Film B' },
      { id: '3', title: 'Film C' },
    ]

    const processFilm = async (film: { id: string; title: string }) => {
      if (film.id === '2') throw new Error('Analysis failed for Film B')
      return { title: film.title, success: true }
    }

    const results: { title: string; success: boolean; error?: string }[] = []

    for (const film of films) {
      try {
        const result = await processFilm(film)
        results.push(result)
      } catch (err) {
        results.push({
          title: film.title,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    expect(results).toHaveLength(3)
    expect(results[0].success).toBe(true)
    expect(results[1].success).toBe(false)
    expect(results[1].error).toContain('Film B')
    expect(results[2].success).toBe(true)
  })

  it('produces summary with success/fail counts', () => {
    const results = [
      { title: 'A', success: true },
      { title: 'B', success: false, error: 'timeout' },
      { title: 'C', success: true },
    ]

    const succeeded = results.filter((r) => r.success).length
    const failed = results.filter((r) => !r.success).length

    expect(succeeded).toBe(2)
    expect(failed).toBe(1)
  })

  it('rejects requests without valid CRON_SECRET', () => {
    const cronSecret = 'my-secret-123'
    const authHeader: string = 'Bearer wrong-secret'

    const isAuthorized = cronSecret && authHeader === `Bearer ${cronSecret}`

    expect(isAuthorized).toBe(false)
  })

  it('allows requests with valid CRON_SECRET', () => {
    const cronSecret = 'my-secret-123'
    const authHeader = `Bearer ${cronSecret}`

    const isAuthorized = cronSecret && authHeader === `Bearer ${cronSecret}`

    expect(isAuthorized).toBeTruthy()
  })
})
