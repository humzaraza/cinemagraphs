import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prisma: {
    film: { findMany: vi.fn(), count: vi.fn() },
  },
  apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/films${query}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prisma.film.findMany.mockResolvedValue([])
  mocks.prisma.film.count.mockResolvedValue(0)
})

describe('GET /api/films', () => {
  describe('?sort=popular', () => {
    it('orders by imdbVotes desc nulls last with title tiebreaker', async () => {
      const { GET } = await import('@/app/api/films/route')
      const res = await GET(getRequest('?sort=popular'))
      expect(res.status).toBe(200)
      expect(mocks.prisma.film.findMany).toHaveBeenCalledTimes(1)
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.orderBy).toEqual([
        { imdbVotes: { sort: 'desc', nulls: 'last' } },
        { title: 'asc' },
      ])
    })

    it('still returns the standard pagination envelope', async () => {
      mocks.prisma.film.findMany.mockResolvedValue([
        { id: 'f1', title: 'Casablanca', imdbVotes: 100, releaseDate: null },
      ])
      mocks.prisma.film.count.mockResolvedValue(1)
      const { GET } = await import('@/app/api/films/route')
      const res = await GET(getRequest('?sort=popular&limit=12'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.films).toHaveLength(1)
      expect(body.pagination).toEqual({ page: 1, limit: 12, total: 1, totalPages: 1 })
    })
  })

  describe('?hasBackdrop=true', () => {
    it('adds a backdropUrl IS NOT NULL filter to the where clause', async () => {
      const { GET } = await import('@/app/api/films/route')
      await GET(getRequest('?hasBackdrop=true'))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where).toMatchObject({ status: 'ACTIVE', backdropUrl: { not: null } })
    })

    it('does not add the filter when omitted', async () => {
      const { GET } = await import('@/app/api/films/route')
      await GET(getRequest(''))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where).not.toHaveProperty('backdropUrl')
    })

    it('does not add the filter when set to anything other than the literal string true', async () => {
      const { GET } = await import('@/app/api/films/route')
      await GET(getRequest('?hasBackdrop=1'))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where).not.toHaveProperty('backdropUrl')
    })
  })

  describe('?q with title contains', () => {
    it('passes a case-insensitive ILIKE contains filter on title', async () => {
      const { GET } = await import('@/app/api/films/route')
      await GET(getRequest('?q=godfather'))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where).toMatchObject({
        title: { contains: 'godfather', mode: 'insensitive' },
      })
    })

    it('combines q with sort=popular and hasBackdrop=true for the picker case', async () => {
      const { GET } = await import('@/app/api/films/route')
      await GET(getRequest('?q=god&sort=popular&hasBackdrop=true&limit=12'))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.where).toMatchObject({
        status: 'ACTIVE',
        title: { contains: 'god', mode: 'insensitive' },
        backdropUrl: { not: null },
      })
      expect(args.orderBy).toEqual([
        { imdbVotes: { sort: 'desc', nulls: 'last' } },
        { title: 'asc' },
      ])
    })
  })

  describe('limit cap', () => {
    it('caps limit at 50', async () => {
      const { GET } = await import('@/app/api/films/route')
      await GET(getRequest('?limit=999'))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.take).toBe(50)
    })

    it('honors a caller-specified limit under the cap', async () => {
      const { GET } = await import('@/app/api/films/route')
      await GET(getRequest('?limit=12'))
      const args = mocks.prisma.film.findMany.mock.calls[0][0]
      expect(args.take).toBe(12)
    })
  })
})
