import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUserFindUnique = vi.fn()
const mockUserFindFirst = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
      findFirst: (...args: unknown[]) => mockUserFindFirst(...args),
    },
  },
}))

import { findUserByAnyEmail } from '@/lib/user-lookup'

beforeEach(() => {
  vi.clearAllMocks()
})

const sampleUser = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Sample',
  image: null,
  role: 'USER' as const,
}

describe('findUserByAnyEmail', () => {
  it('returns user when primary email matches exactly', async () => {
    mockUserFindUnique.mockResolvedValue(sampleUser)

    const result = await findUserByAnyEmail('user@example.com')

    expect(result).toEqual(sampleUser)
    expect(mockUserFindUnique).toHaveBeenCalledWith({
      where: { email: 'user@example.com' },
      select: { id: true, email: true, name: true, image: true, role: true },
    })
  })

  it('lowercases an uppercase input before lookup', async () => {
    mockUserFindUnique.mockResolvedValue(sampleUser)

    const result = await findUserByAnyEmail('USER@example.com')

    expect(result).toEqual(sampleUser)
    expect(mockUserFindUnique.mock.calls[0][0].where.email).toBe('user@example.com')
  })

  it('trims surrounding whitespace before lookup', async () => {
    mockUserFindUnique.mockResolvedValue(sampleUser)

    const result = await findUserByAnyEmail('  user@example.com  ')

    expect(result).toEqual(sampleUser)
    expect(mockUserFindUnique.mock.calls[0][0].where.email).toBe('user@example.com')
  })

  it('falls back to linkedEmails lookup when primary returns null', async () => {
    mockUserFindUnique.mockResolvedValue(null)
    mockUserFindFirst.mockResolvedValue(null)

    await findUserByAnyEmail('linked@example.com')

    expect(mockUserFindUnique).toHaveBeenCalledTimes(1)
    expect(mockUserFindFirst).toHaveBeenCalledTimes(1)
    expect(mockUserFindFirst).toHaveBeenCalledWith({
      where: { linkedEmails: { has: 'linked@example.com' } },
      select: { id: true, email: true, name: true, image: true, role: true },
    })
  })

  it('returns user found via linkedEmails contains', async () => {
    mockUserFindUnique.mockResolvedValue(null)
    mockUserFindFirst.mockResolvedValue(sampleUser)

    const result = await findUserByAnyEmail('linked@example.com')

    expect(result).toEqual(sampleUser)
  })

  it('returns null when neither primary nor linkedEmails match', async () => {
    mockUserFindUnique.mockResolvedValue(null)
    mockUserFindFirst.mockResolvedValue(null)

    const result = await findUserByAnyEmail('missing@example.com')

    expect(result).toBeNull()
  })

  it('primary email match short-circuits the linkedEmails query', async () => {
    mockUserFindUnique.mockResolvedValue(sampleUser)

    await findUserByAnyEmail('user@example.com')

    expect(mockUserFindUnique).toHaveBeenCalledTimes(1)
    expect(mockUserFindFirst).not.toHaveBeenCalled()
  })
})
