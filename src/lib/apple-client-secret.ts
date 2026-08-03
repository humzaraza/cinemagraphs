/**
 * Apple client secret, minted at request time instead of pasted by hand.
 *
 * Apple has no fixed client secret. The `client_secret` sent to their token
 * endpoint is a short-lived ES256 JWT signed with the account's .p8 private
 * key. Historically we signed one by hand with a 6-month expiry
 * (scripts/generate-apple-client-secret.mjs) and pasted the result into the
 * APPLE_SECRET env var, which made every rotation a manual deploy with a
 * hard deadline attached.
 *
 * With APPLE_PRIVATE_KEY set, the server signs its own instead. NextAuth v4
 * calls init() -> parseProviders() on every request, and parseProviders runs
 * Object.entries() over the provider options — which evaluates getters. So a
 * `get clientSecret()` in src/lib/auth.ts lands here once per auth request,
 * and the cache below decides whether to reuse or re-sign. Nothing depends
 * on how long a serverless instance happens to live.
 *
 * Falls back to APPLE_SECRET whenever APPLE_PRIVATE_KEY is absent or
 * unusable, so this is safe to deploy before the key is configured and safe
 * to roll back to by deleting one env var.
 */

import appleSignin from 'apple-signin-auth'
import jwt from 'jsonwebtoken'
import { apiLogger } from './logger'

/** Apple rejects a client_secret whose exp is more than 6 months out. */
export const APPLE_MAX_LIFETIME_SECONDS = 15_777_000

/**
 * Deliberately short. The old value was 6 months because regenerating meant
 * a human doing it; now it costs one ES256 signature, so there is no reason
 * for a leaked token to stay valid for longer than a coffee break.
 */
const LIFETIME_SECONDS = 30 * 60

/** Re-sign once the cached token is within this of expiring. */
const REFRESH_SKEW_SECONDS = 5 * 60

export interface MintedSecret {
  token: string
  expiresAtMs: number
}

let cached: MintedSecret | null = null

/** Test seam — production code never calls this. */
export function resetAppleClientSecretCache(): void {
  cached = null
}

/**
 * Test seam. Object identity is the deterministic signal that a re-sign
 * happened: two tokens signed in the same second carry identical claims and
 * differ only by ECDSA's random nonce, which is not something to assert on.
 */
export function peekAppleClientSecretCache(): MintedSecret | null {
  return cached
}

/**
 * Accepts either a base64-encoded .p8 or a raw PEM.
 *
 * Base64 is the recommended form for env vars: a PEM pasted directly into a
 * dashboard field is one stray newline away from an unparseable key, which
 * is the exact class of failure this module exists to remove. Raw PEM is
 * still accepted (including one with literal "\n" escapes) so a local .env
 * can hold the file contents verbatim.
 */
export function normalizeApplePrivateKey(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.includes('BEGIN PRIVATE KEY')) {
    return trimmed.replace(/\\n/g, '\n')
  }
  return Buffer.from(trimmed, 'base64').toString('utf8').trim()
}

function appleIdentifiers() {
  return {
    clientID: process.env.APPLE_ID ?? 'ca.cinemagraphs.web',
    teamID: process.env.APPLE_TEAM_ID ?? '639P4Q2VAB',
    keyIdentifier: process.env.APPLE_KEY_ID ?? 'SCR59ABFVK',
  }
}

/**
 * Sign a fresh client secret. Throws if the key is unusable — callers are
 * expected to fall back rather than propagate.
 */
export function mintAppleClientSecret(privateKey: string, nowMs: number = Date.now()): MintedSecret {
  const lifetime = Math.min(LIFETIME_SECONDS, APPLE_MAX_LIFETIME_SECONDS)
  const { clientID, teamID, keyIdentifier } = appleIdentifiers()

  const token = appleSignin.getClientSecret({
    clientID,
    teamID,
    keyIdentifier,
    privateKey,
    expAfter: lifetime,
  })

  // Read the expiry back off the token rather than computing it from nowMs.
  // The signer stamps `exp` from its own clock, so deriving it separately
  // lets the cache disagree with the value Apple actually enforces. Falling
  // back to the computed value only matters if decode somehow fails.
  const claims = jwt.decode(token) as { exp?: number } | null
  const expiresAtMs = claims?.exp ? claims.exp * 1000 : nowMs + lifetime * 1000

  return { token, expiresAtMs }
}

/**
 * The value handed to NextAuth's AppleProvider.
 *
 * Never throws: a signing failure logs and degrades to APPLE_SECRET rather
 * than taking down sign-in, because this runs inside NextAuth's per-request
 * provider parsing where an exception would surface as a generic 500.
 */
export function resolveAppleClientSecret(nowMs: number = Date.now()): string {
  const rawKey = process.env.APPLE_PRIVATE_KEY
  if (!rawKey) {
    return process.env.APPLE_SECRET ?? ''
  }

  if (cached && cached.expiresAtMs - nowMs > REFRESH_SKEW_SECONDS * 1000) {
    return cached.token
  }

  try {
    cached = mintAppleClientSecret(normalizeApplePrivateKey(rawKey), nowMs)
    return cached.token
  } catch (err) {
    cached = null
    apiLogger.error(
      { err: { name: (err as Error)?.name, message: (err as Error)?.message } },
      'Apple client secret minting failed; falling back to APPLE_SECRET',
    )
    return process.env.APPLE_SECRET ?? ''
  }
}
