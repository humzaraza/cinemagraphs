import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---- mocks ----
const mockGetMobileOrServerSession = vi.fn()
const mockCheckRateLimit = vi.fn()
const mockApiLoggerInfo = vi.fn()
const mockApiLoggerError = vi.fn()

vi.mock('@/lib/mobile-auth', () => ({
  getMobileOrServerSession: (...args: unknown[]) => mockGetMobileOrServerSession(...args),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

vi.mock('@/lib/logger', () => ({
  apiLogger: {
    info: (...args: unknown[]) => mockApiLoggerInfo(...args),
    error: (...args: unknown[]) => mockApiLoggerError(...args),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

import { POST as eventsPOST } from '@/app/api/events/route'

beforeEach(() => {
  vi.clearAllMocks()
  // Defaults: anonymous session, rate limit allows.
  mockGetMobileOrServerSession.mockResolvedValue(null)
  mockCheckRateLimit.mockResolvedValue({ limited: false, remaining: 100, retryAfterMs: 0 })
})

function buildRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '1.2.3.4',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function lastInfoLog(): { metadata: Record<string, unknown>; message: string } {
  expect(mockApiLoggerInfo).toHaveBeenCalled()
  const call = mockApiLoggerInfo.mock.calls.at(-1)!
  return { metadata: call[0] as Record<string, unknown>, message: call[1] as string }
}

describe('POST /api/events', () => {
  it('authenticated event: logs userId from session and returns 202', async () => {
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'u-42', role: 'USER', name: null, email: 'a@b.com', image: null },
    })

    const res = await eventsPOST(
      buildRequest({ event: 'onboarding_complete', properties: { step: 3 } }),
    )

    expect(res.status).toBe(202)
    const { metadata, message } = lastInfoLog()
    expect(message).toBe('Funnel event')
    expect(metadata.type).toBe('funnel_event')
    expect(metadata.event).toBe('onboarding_complete')
    expect(metadata.userId).toBe('u-42')
    expect(metadata.properties).toEqual({ step: 3 })
    expect(metadata.timestamp).toBeTypeOf('number')

    // Rate limit should key on userId, not IP.
    expect(mockCheckRateLimit).toHaveBeenCalledWith('events', 'u-42', 100, 60 * 1000)
  })

  it('anonymous event: logs userId:null and returns 202', async () => {
    mockGetMobileOrServerSession.mockResolvedValue(null)

    const res = await eventsPOST(buildRequest({ event: 'app_launched' }))

    expect(res.status).toBe(202)
    const { metadata } = lastInfoLog()
    expect(metadata.userId).toBeNull()
    expect(metadata.event).toBe('app_launched')

    // Rate limit should key on IP when no session.
    expect(mockCheckRateLimit).toHaveBeenCalledWith('events', '1.2.3.4', 100, 60 * 1000)
  })

  it('missing event field returns 400 with the documented error message', async () => {
    const res = await eventsPOST(buildRequest({ properties: { foo: 'bar' } }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('event field is required')
    expect(mockApiLoggerInfo).not.toHaveBeenCalled()
  })

  it('event name longer than 50 chars returns 400', async () => {
    const longName = 'a'.repeat(51)

    const res = await eventsPOST(buildRequest({ event: longName }))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/50 characters or fewer/i)
    expect(mockApiLoggerInfo).not.toHaveBeenCalled()
  })

  it('rate limit exceeded returns 429 without logging the event', async () => {
    mockCheckRateLimit.mockResolvedValue({ limited: true, remaining: 0, retryAfterMs: 30_000 })

    const res = await eventsPOST(buildRequest({ event: 'spammy_event' }))

    expect(res.status).toBe(429)
    expect(mockApiLoggerInfo).not.toHaveBeenCalled()
  })

  it('drops non-primitive property values (objects, arrays, null)', async () => {
    const res = await eventsPOST(
      buildRequest({
        event: 'mixed_props',
        properties: {
          str: 'keep',
          num: 42,
          bool: true,
          // These three should be dropped:
          obj: { nested: 'object' } as unknown as string,
          arr: [1, 2, 3] as unknown as string,
          nul: null as unknown as string,
        },
      }),
    )

    expect(res.status).toBe(202)
    const { metadata } = lastInfoLog()
    const props = metadata.properties as Record<string, unknown>
    expect(props.str).toBe('keep')
    expect(props.num).toBe(42)
    expect(props.bool).toBe(true)
    expect('obj' in props).toBe(false)
    expect('arr' in props).toBe(false)
    expect('nul' in props).toBe(false)
  })

  it('truncates string property values to 200 characters', async () => {
    const longValue = 'x'.repeat(300)

    const res = await eventsPOST(
      buildRequest({ event: 'long_prop', properties: { description: longValue } }),
    )

    expect(res.status).toBe(202)
    const { metadata } = lastInfoLog()
    const props = metadata.properties as Record<string, unknown>
    expect((props.description as string).length).toBe(200)
    expect(props.description).toBe('x'.repeat(200))
  })
})
