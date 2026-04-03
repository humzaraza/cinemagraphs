import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before imports
const mockGetServerSession = vi.fn()
const mockPrismaFilmFindUnique = vi.fn()
const mockPrismaFilmUpdate = vi.fn()
const mockPrismaUserFindUnique = vi.fn()
const mockPrismaUserUpdate = vi.fn()
const mockImportMovie = vi.fn()
const mockGenerateSentimentGraph = vi.fn()
const mockInvalidateHomepageCache = vi.fn()
const mockCheckSuspension = vi.fn()

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    film: {
      findUnique: (...args: unknown[]) => mockPrismaFilmFindUnique(...args),
      update: (...args: unknown[]) => mockPrismaFilmUpdate(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockPrismaUserFindUnique(...args),
      update: (...args: unknown[]) => mockPrismaUserUpdate(...args),
    },
  },
}))

vi.mock('@/lib/tmdb', () => ({
  importMovie: (...args: unknown[]) => mockImportMovie(...args),
}))

vi.mock('@/lib/sentiment-pipeline', () => ({
  generateSentimentGraph: (...args: unknown[]) => mockGenerateSentimentGraph(...args),
}))

vi.mock('@/lib/cache', () => ({
  invalidateHomepageCache: (...args: unknown[]) => mockInvalidateHomepageCache(...args),
}))

vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

// We need to mock requireUser and checkSuspension from middleware
vi.mock('@/lib/middleware', () => ({
  requireUser: vi.fn(),
  checkSuspension: (...args: unknown[]) => mockCheckSuspension(...args),
}))

import { POST } from '@/app/api/films/submit/route'
import { requireUser } from '@/lib/middleware'
import { NextRequest } from 'next/server'

const mockRequireUser = vi.mocked(requireUser)

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/films/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function authedSession(userId = 'user-1') {
  return {
    authorized: true,
    session: { user: { id: userId, role: 'USER' } },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckSuspension.mockResolvedValue(null)
  mockGenerateSentimentGraph.mockResolvedValue(undefined)
  mockInvalidateHomepageCache.mockResolvedValue(undefined)
  mockPrismaFilmUpdate.mockResolvedValue({})
  mockPrismaUserUpdate.mockResolvedValue({})
})

describe('Film Submission API', () => {
  describe('Auth gating', () => {
    it('returns 401 for unauthenticated users', async () => {
      mockRequireUser.mockResolvedValue({
        authorized: false,
        session: null,
        errorResponse: Response.json(
          { error: 'Authentication required', code: 'UNAUTHORIZED' },
          { status: 401 }
        ),
      })

      const res = await POST(makeRequest({ tmdbId: 123 }))
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.code).toBe('UNAUTHORIZED')
    })

    it('returns 403 for banned users', async () => {
      mockRequireUser.mockResolvedValue({
        authorized: false,
        session: { user: { id: 'user-1', role: 'BANNED' } },
        errorResponse: Response.json(
          { error: 'Account suspended', code: 'BANNED' },
          { status: 403 }
        ),
      })

      const res = await POST(makeRequest({ tmdbId: 123 }))
      expect(res.status).toBe(403)
    })

    it('returns 403 for suspended users', async () => {
      mockRequireUser.mockResolvedValue(authedSession())
      mockCheckSuspension.mockResolvedValue(
        Response.json(
          { error: 'Your account is temporarily suspended', code: 'SUSPENDED' },
          { status: 403 }
        )
      )

      const res = await POST(makeRequest({ tmdbId: 123 }))
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data.code).toBe('SUSPENDED')
    })
  })

  describe('Deduplication', () => {
    it('returns existing film without importing when tmdbId already exists', async () => {
      mockRequireUser.mockResolvedValue(authedSession())
      mockPrismaFilmFindUnique.mockResolvedValue({ id: 'film-1', title: 'Existing Film' })

      const res = await POST(makeRequest({ tmdbId: 550 }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.alreadyExists).toBe(true)
      expect(data.film.id).toBe('film-1')

      // importMovie should NOT have been called
      expect(mockImportMovie).not.toHaveBeenCalled()
    })

    it('does not update lastFilmAddedAt when film already exists', async () => {
      mockRequireUser.mockResolvedValue(authedSession())
      mockPrismaFilmFindUnique.mockResolvedValue({ id: 'film-1', title: 'Existing Film' })

      await POST(makeRequest({ tmdbId: 550 }))

      expect(mockPrismaUserUpdate).not.toHaveBeenCalled()
    })
  })

  describe('Rate limiting', () => {
    it('returns 429 when user added a film less than 5 hours ago', async () => {
      mockRequireUser.mockResolvedValue(authedSession())
      mockPrismaFilmFindUnique.mockResolvedValue(null) // not a dupe

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      mockPrismaUserFindUnique.mockResolvedValue({ lastFilmAddedAt: twoHoursAgo })

      const res = await POST(makeRequest({ tmdbId: 550 }))
      expect(res.status).toBe(429)
      const data = await res.json()
      expect(data.code).toBe('RATE_LIMITED')
      expect(data.retryAfterMs).toBeGreaterThan(0)
      expect(data.retryAfterMs).toBeLessThanOrEqual(3 * 60 * 60 * 1000) // ~3 hours remaining
    })

    it('allows submission when lastFilmAddedAt is more than 5 hours ago', async () => {
      mockRequireUser.mockResolvedValue(authedSession())
      mockPrismaFilmFindUnique.mockResolvedValue(null)

      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000)
      mockPrismaUserFindUnique.mockResolvedValue({ lastFilmAddedAt: sixHoursAgo })
      mockImportMovie.mockResolvedValue({ id: 'new-film', title: 'New Film' })

      const res = await POST(makeRequest({ tmdbId: 550 }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.created).toBe(true)
    })

    it('allows submission when lastFilmAddedAt is null (first-time)', async () => {
      mockRequireUser.mockResolvedValue(authedSession())
      mockPrismaFilmFindUnique.mockResolvedValue(null)
      mockPrismaUserFindUnique.mockResolvedValue({ lastFilmAddedAt: null })
      mockImportMovie.mockResolvedValue({ id: 'new-film', title: 'New Film' })

      const res = await POST(makeRequest({ tmdbId: 550 }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.created).toBe(true)
    })
  })

  describe('Film creation flow', () => {
    beforeEach(() => {
      mockRequireUser.mockResolvedValue(authedSession('user-42'))
      mockPrismaFilmFindUnique.mockResolvedValue(null)
      mockPrismaUserFindUnique.mockResolvedValue({ lastFilmAddedAt: null })
      mockImportMovie.mockResolvedValue({ id: 'new-film-id', title: 'Fight Club' })
    })

    it('calls importMovie with the tmdbId', async () => {
      await POST(makeRequest({ tmdbId: 550 }))
      expect(mockImportMovie).toHaveBeenCalledWith(550)
    })

    it('sets addedByUserId on the created film', async () => {
      await POST(makeRequest({ tmdbId: 550 }))
      expect(mockPrismaFilmUpdate).toHaveBeenCalledWith({
        where: { id: 'new-film-id' },
        data: { addedByUserId: 'user-42' },
      })
    })

    it('updates lastFilmAddedAt on the user', async () => {
      await POST(makeRequest({ tmdbId: 550 }))
      expect(mockPrismaUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-42' },
          data: expect.objectContaining({ lastFilmAddedAt: expect.any(Date) }),
        })
      )
    })

    it('triggers generateSentimentGraph', async () => {
      await POST(makeRequest({ tmdbId: 550 }))
      expect(mockGenerateSentimentGraph).toHaveBeenCalledWith('new-film-id')
    })

    it('returns success response with film data', async () => {
      const res = await POST(makeRequest({ tmdbId: 550 }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.created).toBe(true)
      expect(data.film.id).toBe('new-film-id')
      expect(data.film.title).toBe('Fight Club')
      expect(data.message).toContain('Film added')
    })

    it('returns 400 for invalid tmdbId', async () => {
      const res = await POST(makeRequest({ tmdbId: -1 }))
      expect(res.status).toBe(400)
    })
  })
})
