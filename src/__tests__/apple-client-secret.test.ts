import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'

vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import {
  resolveAppleClientSecret,
  mintAppleClientSecret,
  normalizeApplePrivateKey,
  resetAppleClientSecretCache,
  peekAppleClientSecretCache,
  APPLE_MAX_LIFETIME_SECONDS,
} from '@/lib/apple-client-secret'

// Apple requires ES256, which requires a P-256 key. Generated per run so no
// key material — not even a throwaway one — lives in the repo.
const { privateKey: PEM } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const BASE64_PEM = Buffer.from(PEM, 'utf8').toString('base64')

const ENV_KEYS = [
  'APPLE_PRIVATE_KEY',
  'APPLE_SECRET',
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'APPLE_KEY_ID',
] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  resetAppleClientSecretCache()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetAppleClientSecretCache()
})

function decode(token: string) {
  const decoded = jwt.decode(token, { complete: true })
  if (!decoded) throw new Error('token did not decode')
  return decoded as unknown as {
    header: Record<string, unknown>
    payload: Record<string, unknown>
  }
}

describe('resolveAppleClientSecret — fallback behaviour', () => {
  it('returns APPLE_SECRET verbatim when no private key is configured', () => {
    process.env.APPLE_SECRET = 'pre-signed-jwt'
    expect(resolveAppleClientSecret()).toBe('pre-signed-jwt')
  })

  it('returns empty string when neither the key nor APPLE_SECRET is set', () => {
    // Matches the previous behaviour of `process.env.APPLE_SECRET!` being
    // undefined: NextAuth surfaces its own config error rather than us
    // throwing from inside provider parsing.
    expect(resolveAppleClientSecret()).toBe('')
  })

  it('falls back to APPLE_SECRET when the private key is unusable', () => {
    process.env.APPLE_PRIVATE_KEY = 'not-a-key'
    process.env.APPLE_SECRET = 'pre-signed-jwt'
    expect(resolveAppleClientSecret()).toBe('pre-signed-jwt')
  })

  it('never throws on a bad key, even with no fallback configured', () => {
    // This runs inside NextAuth's per-request provider parsing, where an
    // exception would become an opaque 500 on every auth route.
    process.env.APPLE_PRIVATE_KEY = 'not-a-key'
    expect(() => resolveAppleClientSecret()).not.toThrow()
    expect(resolveAppleClientSecret()).toBe('')
  })
})

describe('resolveAppleClientSecret — minting', () => {
  it('signs a token with the claims Apple requires', () => {
    process.env.APPLE_PRIVATE_KEY = BASE64_PEM
    process.env.APPLE_ID = 'ca.cinemagraphs.web'
    process.env.APPLE_TEAM_ID = '639P4Q2VAB'
    process.env.APPLE_KEY_ID = 'SCR59ABFVK'

    const { header, payload } = decode(resolveAppleClientSecret())

    expect(header.alg).toBe('ES256')
    expect(header.kid).toBe('SCR59ABFVK')
    expect(payload.iss).toBe('639P4Q2VAB')
    expect(payload.sub).toBe('ca.cinemagraphs.web')
    expect(payload.aud).toBe('https://appleid.apple.com')
  })

  it('prefers the minted token over a stale APPLE_SECRET', () => {
    process.env.APPLE_PRIVATE_KEY = BASE64_PEM
    process.env.APPLE_SECRET = 'stale-pre-signed-jwt'
    expect(resolveAppleClientSecret()).not.toBe('stale-pre-signed-jwt')
  })

  it('accepts a raw PEM as well as base64', () => {
    process.env.APPLE_PRIVATE_KEY = PEM
    expect(() => decode(resolveAppleClientSecret())).not.toThrow()
  })

  it('accepts a PEM whose newlines survived as literal backslash-n', () => {
    // How a .p8 usually arrives when pasted through a form that escapes it.
    process.env.APPLE_PRIVATE_KEY = PEM.replace(/\n/g, '\\n')
    expect(() => decode(resolveAppleClientSecret())).not.toThrow()
  })

  it('stays well inside Apple 6-month ceiling', () => {
    process.env.APPLE_PRIVATE_KEY = BASE64_PEM
    const { payload } = decode(resolveAppleClientSecret())
    const lifetime = (payload.exp as number) - (payload.iat as number)

    expect(lifetime).toBeGreaterThan(0)
    expect(lifetime).toBeLessThanOrEqual(APPLE_MAX_LIFETIME_SECONDS)
    expect(lifetime).toBeLessThanOrEqual(60 * 60)
  })
})

describe('resolveAppleClientSecret — caching', () => {
  // Cache times are anchored to the real clock because the token's `exp` is
  // stamped by the signer, not by the nowMs we pass in. Offsets from
  // Date.now() keep the two on the same timeline.
  it('reuses the cached token across calls inside the window', () => {
    process.env.APPLE_PRIVATE_KEY = BASE64_PEM
    const now = Date.now()
    expect(resolveAppleClientSecret(now)).toBe(resolveAppleClientSecret(now + 1000))
  })

  it('re-signs once the cached token nears expiry', () => {
    process.env.APPLE_PRIVATE_KEY = BASE64_PEM
    const now = Date.now()

    resolveAppleClientSecret(now)
    const before = peekAppleClientSecretCache()

    // 29 minutes on: inside the 30-minute lifetime but within the 5-minute
    // refresh skew, so it should already have been replaced.
    resolveAppleClientSecret(now + 29 * 60 * 1000)
    const after = peekAppleClientSecretCache()

    expect(before).not.toBeNull()
    expect(after).not.toBe(before)
  })

  it('does not re-sign on every call while the window is wide open', () => {
    process.env.APPLE_PRIVATE_KEY = BASE64_PEM
    const now = Date.now()

    resolveAppleClientSecret(now)
    const before = peekAppleClientSecretCache()
    resolveAppleClientSecret(now + 60 * 1000)

    expect(peekAppleClientSecretCache()).toBe(before)
  })

  it('does not serve a cached token after the key is removed', () => {
    process.env.APPLE_PRIVATE_KEY = BASE64_PEM
    const minted = resolveAppleClientSecret()
    expect(minted).not.toBe('')

    delete process.env.APPLE_PRIVATE_KEY
    process.env.APPLE_SECRET = 'pre-signed-jwt'
    expect(resolveAppleClientSecret()).toBe('pre-signed-jwt')
  })
})

describe('helpers', () => {
  it('normalizeApplePrivateKey round-trips base64 and passes PEM through', () => {
    expect(normalizeApplePrivateKey(BASE64_PEM)).toBe(PEM.trim())
    expect(normalizeApplePrivateKey(PEM)).toBe(PEM.trim())
  })

  it('mintAppleClientSecret reports the expiry the token actually carries', () => {
    const { token, expiresAtMs } = mintAppleClientSecret(PEM)
    const { payload } = decode(token)

    expect(expiresAtMs).toBe((payload.exp as number) * 1000)
    expect(expiresAtMs).toBeGreaterThan(Date.now())
  })
})
