import { describe, it, expect, beforeEach } from 'vitest'
import pino from 'pino'
import { redactConfig } from '@/lib/logger'
import { serializeAuthError } from '@/lib/auth-error'

// Construct a parallel pino instance using the actual production redact
// config and capture output via a custom destination stream. This lets us
// assert the *real* config redacts as intended without depending on the
// exported `logger` writing to a real stdout fd.
let captured: string[]
let testLogger: pino.Logger

function lastLogged(): Record<string, unknown> {
  expect(captured.length).toBeGreaterThan(0)
  return JSON.parse(captured[captured.length - 1])
}

beforeEach(() => {
  captured = []
  const destStream = {
    write: (msg: string) => {
      captured.push(msg)
    },
  }
  testLogger = pino(
    {
      level: 'debug',
      formatters: { level: (label) => ({ level: label }) },
      redact: redactConfig,
    },
    destStream,
  )
})

describe('logger redact config', () => {
  // Pino's `*.password` wildcard matches nested `password` keys (e.g.
  // `user.password`), not a top-level `password` at the record root.
  // The redact config protects against PII buried in serialized request/
  // response objects — the more common accidental-logging vector.

  it('redacts password in a nested object', () => {
    testLogger.info({ user: { password: 'super-secret' } }, 'login attempt')

    const out = lastLogged() as { user: Record<string, unknown> }
    expect(out.user.password).toBe('[Redacted]')
  })

  it('redacts token, accessToken, and refreshToken under a parent key', () => {
    testLogger.info(
      { payload: { token: 't', accessToken: 'a', refreshToken: 'r' } },
      'token issuance',
    )

    const out = lastLogged() as { payload: Record<string, unknown> }
    expect(out.payload.token).toBe('[Redacted]')
    expect(out.payload.accessToken).toBe('[Redacted]')
    expect(out.payload.refreshToken).toBe('[Redacted]')
  })

  it('redacts idToken and identityToken under a parent key', () => {
    testLogger.info(
      { body: { idToken: 'google-id-token', identityToken: 'apple-identity-token' } },
      'oauth verify',
    )

    const out = lastLogged() as { body: Record<string, unknown> }
    expect(out.body.idToken).toBe('[Redacted]')
    expect(out.body.identityToken).toBe('[Redacted]')
  })

  it('redacts authorization header in nested req.headers', () => {
    testLogger.info(
      { req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'session=xyz' } } },
      'incoming request',
    )

    const out = lastLogged() as { req: { headers: Record<string, string> } }
    expect(out.req.headers.authorization).toBe('[Redacted]')
    expect(out.req.headers.cookie).toBe('[Redacted]')
  })

  it('passes non-sensitive fields (userId, email, family) through unredacted', () => {
    testLogger.info(
      { userId: 'u-123', email: 'a@b.com', family: 'fam-xyz' },
      'audit event',
    )

    const out = lastLogged()
    expect(out.userId).toBe('u-123')
    expect(out.email).toBe('a@b.com')
    expect(out.family).toBe('fam-xyz')
  })

  // Top-level redaction (Chunk 6b). Pino's `*.field` only matches one
  // level of nesting; bare path entries are required to catch direct
  // logging like apiLogger.info({ password: 'x' }).

  it('redacts top-level password', () => {
    testLogger.info({ password: 'super-secret' }, 'login attempt')

    const out = lastLogged()
    expect(out.password).toBe('[Redacted]')
  })

  it('redacts top-level token', () => {
    testLogger.info({ token: 'jwt-bytes' }, 'token check')

    const out = lastLogged()
    expect(out.token).toBe('[Redacted]')
  })

  it('redacts top-level accessToken', () => {
    testLogger.info({ accessToken: 'access-jwt' }, 'session check')

    const out = lastLogged()
    expect(out.accessToken).toBe('[Redacted]')
  })

  it('redacts top-level refresh_token (snake_case OAuth variant)', () => {
    testLogger.info({ refresh_token: 'oauth-refresh' }, 'oauth callback')

    const out = lastLogged()
    expect(out.refresh_token).toBe('[Redacted]')
  })
})

// Regression cover for the Apple sign-in outage: NextAuth v4 wraps provider
// failures in UnknownError, whose toJSON() emits only { name, message } —
// and the message is '' for OAuth callback failures. Logging `metadata`
// directly produced records that named the error and said nothing else.
describe('serializeAuthError', () => {
  it('keeps the stack when the wrapper message is empty', () => {
    const wrapped = Object.assign(new Error(''), {
      name: 'OAuthCallbackError',
      stack: 'OPError: invalid_client\n    at processTokenResponse',
      code: 'ERR_OAUTH',
    })

    const out = serializeAuthError(wrapped) as Record<string, unknown>
    expect(out.name).toBe('OAuthCallbackError')
    expect(out.message).toBe('')
    expect(out.stack).toContain('invalid_client')
    expect(out.code).toBe('ERR_OAUTH')
  })

  it('surfaces openid-client error / error_description / response body', () => {
    const opError = Object.assign(new Error('invalid_client'), {
      name: 'OPError',
      error: 'invalid_client',
      error_description: 'Client authentication failed.',
      response: { statusCode: 400, body: { error: 'invalid_client' } },
    })

    const out = serializeAuthError(opError) as Record<string, unknown>
    expect(out.error).toBe('invalid_client')
    expect(out.error_description).toBe('Client authentication failed.')
    expect(out.response).toEqual({ statusCode: 400, body: { error: 'invalid_client' } })
  })

  it('walks the cause chain to the underlying provider error', () => {
    const wrapped = Object.assign(new Error(''), {
      name: 'OAuthCallbackError',
      cause: Object.assign(new Error('invalid_client'), { error: 'invalid_client' }),
    })

    const out = serializeAuthError(wrapped) as Record<string, unknown>
    const cause = out.cause as Record<string, unknown>
    expect(cause.message).toBe('invalid_client')
    expect(cause.error).toBe('invalid_client')
  })

  it('does not loop on a self-referential cause chain', () => {
    const err = new Error('boom') as Error & { cause?: unknown }
    err.cause = err

    const out = serializeAuthError(err) as Record<string, unknown>
    expect(JSON.stringify(out)).toContain('truncated')
  })

  it('handles non-object and nullish inputs', () => {
    expect(serializeAuthError(undefined)).toBeUndefined()
    expect(serializeAuthError(null)).toBeNull()
    expect(serializeAuthError('plain string')).toEqual({ value: 'plain string' })
  })

  it('redacts tokens echoed back inside a provider error response body', () => {
    const opError = Object.assign(new Error('bad grant'), {
      name: 'OPError',
      response: { statusCode: 400, body: { access_token: 'leaky', id_token: 'leaky' } },
    })

    testLogger.error({ err: serializeAuthError(opError) }, 'NextAuth error')

    const out = lastLogged() as { err: { response: { body: Record<string, unknown> } } }
    expect(out.err.response.body.access_token).toBe('[Redacted]')
    expect(out.err.response.body.id_token).toBe('[Redacted]')
  })
})
