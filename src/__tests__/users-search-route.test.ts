import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findMany: vi.fn(), count: vi.fn() },
  },
  apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))

const userRow = {
  id: 'user_1',
  name: 'Alice',
  username: 'alice',
  email: 'alice@example.com',
  image: null,
  bio: null,
  _count: { userReviews: 2, followers: 1, following: 3 },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prisma.user.findMany.mockResolvedValue([userRow])
  mocks.prisma.user.count.mockResolvedValue(1)
})

describe('GET /api/users/search', () => {
  it('searches all users regardless of isPublic, excluding banned users', async () => {
    const { GET } = await import('@/app/api/users/search/route')
    const res = await GET(new NextRequest('http://localhost/api/users/search?q=ali'))
    expect(res.status).toBe(200)

    // Exact match on `where` pins the open-social behavior: no isPublic
    // filter may reappear, and the BANNED exclusion (moderation, not
    // privacy) must stay.
    const expectedWhere = {
      role: { not: 'BANNED' },
      OR: [
        { name: { contains: 'ali', mode: 'insensitive' } },
        { username: { contains: 'ali', mode: 'insensitive' } },
      ],
    }
    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere })
    )
    expect(mocks.prisma.user.count).toHaveBeenCalledWith({ where: expectedWhere })
  })

  it('returns 400 when the query is missing', async () => {
    const { GET } = await import('@/app/api/users/search/route')
    const res = await GET(new NextRequest('http://localhost/api/users/search'))
    expect(res.status).toBe(400)
    expect(mocks.prisma.user.findMany).not.toHaveBeenCalled()
  })
})
