/**
 * Log-safe flattening for auth/OAuth errors.
 *
 * Lives outside logger.ts on purpose: 45 test files call
 * vi.mock('@/lib/logger', ...) with hand-written export maps, and vitest
 * throws on any named export a mock factory omits. Keeping this here means
 * adding to it never forces a sweep through those mocks.
 */

/**
 * Flatten an error into a plain, log-safe object that keeps the fields
 * NextAuth v4 and openid-client actually put the cause in.
 *
 * next-auth v4 wraps provider errors in UnknownError, and
 * UnknownError.toJSON() returns only { name, message }. For OAuth callback
 * failures the message is frequently '' — so serializing the error
 * normally produces a record that says nothing. UnknownError does however
 * copy the original error's `stack` and `code`, and openid-client's
 * OPError/RPError carry `error`, `error_description` and the raw
 * `response.body`. Those are what identify invalid_client, a bad JWT, or a
 * missing state/nonce cookie.
 *
 * Depth-limited so a self-referential `cause` chain cannot loop.
 */
export function serializeAuthError(err: unknown, depth = 0): unknown {
  if (err === null || err === undefined) return err
  if (typeof err !== 'object') return { value: String(err) }
  if (depth > 3) return { truncated: true }

  const e = err as Record<string, unknown>
  const out: Record<string, unknown> = {
    name: e.name,
    message: e.message,
    stack: e.stack,
  }

  for (const key of [
    'code',
    'error',
    'error_description',
    'error_uri',
    'statusCode',
    'checks',
    'body',
  ]) {
    if (e[key] !== undefined) out[key] = e[key]
  }

  const response = e.response as Record<string, unknown> | undefined
  if (response && typeof response === 'object') {
    out.response = { statusCode: response.statusCode, body: response.body }
  }

  if (e.cause !== undefined && e.cause !== null) {
    out.cause = serializeAuthError(e.cause, depth + 1)
  }

  return out
}
