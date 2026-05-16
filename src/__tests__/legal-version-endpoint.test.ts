import { describe, it, expect } from 'vitest'

import { GET } from '@/app/api/legal/version/route'

describe('GET /api/legal/version', () => {
  it('returns 200 with the current terms version', async () => {
    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ version: '2026-05-15' })
  })
})
