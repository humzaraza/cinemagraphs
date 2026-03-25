import { describe, it, expect } from 'vitest'

// Test the error response shape contract
interface ErrorResponse {
  error: string
  code: string
}

function createErrorResponse(error: string, code: string, status: number): Response {
  return Response.json({ error, code } satisfies ErrorResponse, { status })
}

describe('API Error Response Shape', () => {
  it('returns { error, code } on 400 Bad Request', async () => {
    const res = createErrorResponse('Search query is required', 'BAD_REQUEST', 400)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body).toHaveProperty('code')
    expect(body.code).toBe('BAD_REQUEST')
    expect(typeof body.error).toBe('string')
  })

  it('returns { error, code } on 401 Unauthorized', async () => {
    const res = createErrorResponse('Authentication required', 'UNAUTHORIZED', 401)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.code).toBe('UNAUTHORIZED')
  })

  it('returns { error, code } on 403 Forbidden', async () => {
    const res = createErrorResponse('Insufficient permissions', 'FORBIDDEN', 403)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('FORBIDDEN')
  })

  it('returns { error, code } on 404 Not Found', async () => {
    const res = createErrorResponse('Film not found', 'NOT_FOUND', 404)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.code).toBe('NOT_FOUND')
  })

  it('returns { error, code } on 500 Internal Server Error', async () => {
    const res = createErrorResponse('Analysis failed', 'INTERNAL_ERROR', 500)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.code).toBe('INTERNAL_ERROR')
  })

  it('error field is always a non-empty string', async () => {
    const res = createErrorResponse('Something broke', 'INTERNAL_ERROR', 500)
    const body = await res.json()

    expect(body.error.length).toBeGreaterThan(0)
  })
})
