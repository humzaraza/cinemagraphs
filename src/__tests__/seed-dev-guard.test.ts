import { describe, it, expect } from 'vitest'
import { assertDevDatabase } from '../../scripts/seed-dev-guard'

// Host formats copied verbatim from the real .env.local, so the guard is
// tested against the shape Neon actually hands out rather than an assumed one.
const POOLED_HOST = 'ep-cool-lake-ana2eadk-pooler.c-6.us-east-1.aws.neon.tech'
const DIRECT_HOST = 'ep-cool-lake-ana2eadk.c-6.us-east-1.aws.neon.tech'
// Same Neon host shape, different endpoint: this is what a non-dev target
// looks like, and it must not pass.
const SHADOW_HOST = 'ep-plain-shadow-b7f3d211.c-6.us-east-1.aws.neon.tech'

const PASSWORD = 'npg_SuperSecretPassword123'

function url(host: string): string {
  return `postgresql://neondb_owner:${PASSWORD}@${host}/neondb?sslmode=require`
}

describe('assertDevDatabase', () => {
  it('returns the host for a cool-lake pooled URL', () => {
    expect(assertDevDatabase(url(POOLED_HOST))).toBe(POOLED_HOST)
  })

  it('returns the host for a cool-lake direct URL', () => {
    expect(assertDevDatabase(url(DIRECT_HOST))).toBe(DIRECT_HOST)
  })

  it('throws for a plain-shadow URL and names the host it saw', () => {
    expect(() => assertDevDatabase(url(SHADOW_HOST))).toThrow(SHADOW_HOST)
  })

  it('throws for undefined', () => {
    expect(() => assertDevDatabase(undefined)).toThrow(/no database connection string/i)
  })

  it('throws for an empty string', () => {
    expect(() => assertDevDatabase('')).toThrow(/no database connection string/i)
  })

  it('throws for a whitespace-only string', () => {
    expect(() => assertDevDatabase('   ')).toThrow(/no database connection string/i)
  })

  it('throws for a malformed non-URL string', () => {
    expect(() => assertDevDatabase('not-a-url-at-all')).toThrow(/not a parseable URL/i)
  })

  it('throws for a URL that parses but carries no host', () => {
    expect(() => assertDevDatabase('postgresql:neondb')).toThrow(/no host/i)
  })

  it('throws when the host merely resembles the dev host', () => {
    // "cool-lake" must appear in the host, not somewhere else in the string.
    expect(() =>
      assertDevDatabase(`postgresql://cool-lake:${PASSWORD}@${SHADOW_HOST}/neondb`)
    ).toThrow(SHADOW_HOST)
  })

  it('never puts the password in the thrown message', () => {
    const inputs = [
      url(SHADOW_HOST),
      `postgresql://neondb_owner:${PASSWORD}@/neondb`,
      `not a url ${PASSWORD}`,
    ]
    for (const input of inputs) {
      let message = ''
      try {
        assertDevDatabase(input)
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).not.toBe('')
      expect(message).not.toContain(PASSWORD)
      expect(message).not.toContain(input)
    }
  })
})
