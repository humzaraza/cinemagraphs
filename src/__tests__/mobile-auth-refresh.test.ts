import { describe, it, expect, vi, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-mobile-auth-unit-tests'
})

const mockRefreshTokenCreate = vi.fn()
const mockRefreshTokenUpdate = vi.fn()
const mockRefreshTokenFindUnique = vi.fn()
const mockRefreshTokenUpdateMany = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    refreshToken: {
      create: (...args: unknown[]) => mockRefreshTokenCreate(...args),
      update: (...args: unknown[]) => mockRefreshTokenUpdate(...args),
      findUnique: (...args: unknown[]) => mockRefreshTokenFindUnique(...args),
      updateMany: (...args: unknown[]) => mockRefreshTokenUpdateMany(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import {
  signAccessToken,
  hashRefreshToken,
  issueRefreshToken,
  verifyAndRotateRefreshToken,
  revokeRefreshTokenFamily,
  type MobileTokenPayload,
} from '@/lib/mobile-auth'

beforeEach(() => {
  vi.clearAllMocks()
})

const samplePayload: MobileTokenPayload = {
  id: 'user-1',
  email: 'a@b.com',
  name: 'Alice',
  role: 'USER',
  picture: null,
}

describe('signAccessToken', () => {
  it('produces a JWT that decodes back to the original payload', () => {
    const token = signAccessToken(samplePayload)
    const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET!) as MobileTokenPayload & {
      iat: number
      exp: number
    }
    expect(decoded.id).toBe(samplePayload.id)
    expect(decoded.email).toBe(samplePayload.email)
    expect(decoded.name).toBe(samplePayload.name)
    expect(decoded.role).toBe(samplePayload.role)
    expect(decoded.picture).toBe(samplePayload.picture)
    expect(decoded.exp - decoded.iat).toBe(15 * 60)
  })
})

describe('hashRefreshToken', () => {
  it('is deterministic and returns 64 hex chars', () => {
    const a = hashRefreshToken('abc123')
    const b = hashRefreshToken('abc123')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces different hashes for different inputs', () => {
    expect(hashRefreshToken('a')).not.toBe(hashRefreshToken('b'))
  })
})

describe('issueRefreshToken', () => {
  it('creates a row then updates family to the row id, returns 64-char hex', async () => {
    mockRefreshTokenCreate.mockResolvedValue({ id: 'new-row-id' })
    mockRefreshTokenUpdate.mockResolvedValue({ id: 'new-row-id', family: 'new-row-id' })

    const raw = await issueRefreshToken('user-1')

    expect(raw).toMatch(/^[0-9a-f]{64}$/)
    expect(mockRefreshTokenCreate).toHaveBeenCalledTimes(1)
    const createCall = mockRefreshTokenCreate.mock.calls[0][0]
    expect(createCall.data.userId).toBe('user-1')
    expect(createCall.data.family).toBe('pending')
    expect(createCall.data.tokenHash).toBe(hashRefreshToken(raw))
    expect(createCall.data.expiresAt).toBeInstanceOf(Date)

    expect(mockRefreshTokenUpdate).toHaveBeenCalledTimes(1)
    expect(mockRefreshTokenUpdate.mock.calls[0][0]).toEqual({
      where: { id: 'new-row-id' },
      data: { family: 'new-row-id' },
    })
  })
})

describe('verifyAndRotateRefreshToken', () => {
  const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24)
  const pastDate = new Date(Date.now() - 1000)
  const baseUser = {
    id: 'user-1',
    email: 'a@b.com',
    name: 'Alice',
    role: 'USER',
    image: null,
  }

  it('happy path: rotates valid unrotated token and marks old as replaced+revoked', async () => {
    mockRefreshTokenFindUnique.mockResolvedValue({
      id: 'old-id',
      userId: 'user-1',
      family: 'fam-1',
      tokenHash: hashRefreshToken('raw-old'),
      expiresAt: futureDate,
      replacedById: null,
      revokedAt: null,
      user: baseUser,
    })
    mockRefreshTokenCreate.mockResolvedValue({ id: 'new-id' })
    mockRefreshTokenUpdate.mockResolvedValue({})

    const result = await verifyAndRotateRefreshToken('raw-old')

    expect(result).not.toBeNull()
    expect(result!.refreshToken).toMatch(/^[0-9a-f]{64}$/)
    expect(result!.refreshToken).not.toBe('raw-old')
    expect(result!.user.id).toBe('user-1')

    const decoded = jwt.verify(result!.accessToken, process.env.NEXTAUTH_SECRET!) as MobileTokenPayload
    expect(decoded.id).toBe('user-1')

    expect(mockRefreshTokenCreate).toHaveBeenCalledTimes(1)
    const createCall = mockRefreshTokenCreate.mock.calls[0][0]
    expect(createCall.data.userId).toBe('user-1')
    expect(createCall.data.family).toBe('fam-1')

    expect(mockRefreshTokenUpdate).toHaveBeenCalledTimes(1)
    const updateCall = mockRefreshTokenUpdate.mock.calls[0][0]
    expect(updateCall.where).toEqual({ id: 'old-id' })
    expect(updateCall.data.replacedById).toBe('new-id')
    expect(updateCall.data.revokedAt).toBeInstanceOf(Date)
  })

  it('replay detection: token with non-null replacedById revokes family and returns null', async () => {
    mockRefreshTokenFindUnique.mockResolvedValue({
      id: 'replayed-id',
      userId: 'user-1',
      family: 'fam-1',
      tokenHash: hashRefreshToken('raw-replayed'),
      expiresAt: futureDate,
      replacedById: 'newer-id',
      revokedAt: new Date(),
      user: baseUser,
    })
    mockRefreshTokenUpdateMany.mockResolvedValue({ count: 3 })

    const result = await verifyAndRotateRefreshToken('raw-replayed')

    expect(result).toBeNull()
    expect(mockRefreshTokenUpdateMany).toHaveBeenCalledTimes(1)
    const updateManyCall = mockRefreshTokenUpdateMany.mock.calls[0][0]
    expect(updateManyCall.where.family).toBe('fam-1')
    expect(updateManyCall.where.revokedAt).toBeNull()
    expect(updateManyCall.data.revokedAt).toBeInstanceOf(Date)

    expect(mockRefreshTokenCreate).not.toHaveBeenCalled()
    expect(mockRefreshTokenUpdate).not.toHaveBeenCalled()
  })

  it('expired: token past expiresAt returns null without rotating', async () => {
    mockRefreshTokenFindUnique.mockResolvedValue({
      id: 'expired-id',
      userId: 'user-1',
      family: 'fam-1',
      tokenHash: hashRefreshToken('raw-expired'),
      expiresAt: pastDate,
      replacedById: null,
      revokedAt: null,
      user: baseUser,
    })

    const result = await verifyAndRotateRefreshToken('raw-expired')

    expect(result).toBeNull()
    expect(mockRefreshTokenCreate).not.toHaveBeenCalled()
    expect(mockRefreshTokenUpdate).not.toHaveBeenCalled()
    expect(mockRefreshTokenUpdateMany).not.toHaveBeenCalled()
  })

  it('revoked: token with non-null revokedAt returns null', async () => {
    mockRefreshTokenFindUnique.mockResolvedValue({
      id: 'revoked-id',
      userId: 'user-1',
      family: 'fam-1',
      tokenHash: hashRefreshToken('raw-revoked'),
      expiresAt: futureDate,
      replacedById: null,
      revokedAt: new Date(),
      user: baseUser,
    })

    const result = await verifyAndRotateRefreshToken('raw-revoked')

    expect(result).toBeNull()
    expect(mockRefreshTokenCreate).not.toHaveBeenCalled()
    expect(mockRefreshTokenUpdate).not.toHaveBeenCalled()
    expect(mockRefreshTokenUpdateMany).not.toHaveBeenCalled()
  })

  it('not found: unknown hash returns null', async () => {
    mockRefreshTokenFindUnique.mockResolvedValue(null)

    const result = await verifyAndRotateRefreshToken('raw-unknown')

    expect(result).toBeNull()
    expect(mockRefreshTokenCreate).not.toHaveBeenCalled()
    expect(mockRefreshTokenUpdate).not.toHaveBeenCalled()
    expect(mockRefreshTokenUpdateMany).not.toHaveBeenCalled()
  })
})

describe('revokeRefreshTokenFamily', () => {
  it('updates all non-revoked tokens in the family', async () => {
    mockRefreshTokenUpdateMany.mockResolvedValue({ count: 2 })

    await revokeRefreshTokenFamily('fam-xyz')

    expect(mockRefreshTokenUpdateMany).toHaveBeenCalledTimes(1)
    const call = mockRefreshTokenUpdateMany.mock.calls[0][0]
    expect(call.where.family).toBe('fam-xyz')
    expect(call.where.revokedAt).toBeNull()
    expect(call.data.revokedAt).toBeInstanceOf(Date)
  })
})
