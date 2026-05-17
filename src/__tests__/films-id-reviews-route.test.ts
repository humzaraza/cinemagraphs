import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  prisma: {
    userReview: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
    },
  },
  apiLogger: { error: vi.fn() },
  getMobileOrServerSession: vi.fn(),
  // The route imports these for its POST/edit paths. GET never calls them, but
  // module load needs the import to resolve, so we stub them.
  extractSentiment: vi.fn(),
  maybeBlendAndUpdate: vi.fn(),
  checkSuspension: vi.fn(),
  invalidateFilmCache: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))
vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/sentiment-extract', () => ({ extractSentiment: mocks.extractSentiment }))
vi.mock('@/lib/review-blender', () => ({ maybeBlendAndUpdate: mocks.maybeBlendAndUpdate }))
vi.mock('@/lib/middleware', () => ({ checkSuspension: mocks.checkSuspension }))
vi.mock('@/lib/cache', () => ({ invalidateFilmCache: mocks.invalidateFilmCache }))

const FILM_ID = 'film-1'
const USER_ID = 'me'

function makeRequest(query = '') {
  return new Request(`http://localhost/api/films/${FILM_ID}/reviews${query}`)
}

async function callGET(query = '') {
  const { GET } = await import('@/app/api/films/[id]/reviews/route')
  // The route signature expects NextRequest; a plain Request works at runtime
  // because GET only reads url + searchParams.
  return GET(makeRequest(query) as unknown as Parameters<typeof GET>[0], {
    params: Promise.resolve({ id: FILM_ID }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue(null)
  mocks.prisma.userReview.findMany.mockResolvedValue([])
  mocks.prisma.userReview.count.mockResolvedValue(0)
  mocks.prisma.userReview.findUnique.mockResolvedValue(null)
})

describe('GET /api/films/[id]/reviews — excludeCurrentUser', () => {
  it('absent param: returns all approved reviews (existing behavior)', async () => {
    const res = await callGET('')
    expect(res.status).toBe(200)

    const listCall = mocks.prisma.userReview.findMany.mock.calls.find(
      ([arg]) => (arg as { where?: { status?: string } })?.where?.status === 'approved',
    )!
    expect((listCall[0] as { where: Record<string, unknown> }).where).toEqual({
      filmId: FILM_ID,
      status: 'approved',
    })
    expect(mocks.prisma.userReview.count).toHaveBeenCalledWith({
      where: { filmId: FILM_ID, status: 'approved' },
    })
  })

  it('excludeCurrentUser=false: returns all approved reviews (existing behavior)', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
    const res = await callGET('?excludeCurrentUser=false')
    expect(res.status).toBe(200)

    expect(mocks.prisma.userReview.count).toHaveBeenCalledWith({
      where: { filmId: FILM_ID, status: 'approved' },
    })
    // No userId filter applied
    const listCall = mocks.prisma.userReview.findMany.mock.calls.find(
      ([arg]) => (arg as { where?: { status?: string } })?.where?.status === 'approved',
    )!
    const where = (listCall[0] as { where: Record<string, unknown> }).where
    expect(where).not.toHaveProperty('userId')
  })

  it('excludeCurrentUser=true + authenticated: excludes reviews by the current user from the list and count', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
    const res = await callGET('?excludeCurrentUser=true')
    expect(res.status).toBe(200)

    const expectedFilter = {
      filmId: FILM_ID,
      status: 'approved',
      userId: { not: USER_ID },
    }
    // findMany for the paginated list must use the filtered where
    const listCall = mocks.prisma.userReview.findMany.mock.calls.find(
      ([arg]) => (arg as { skip?: number })?.skip !== undefined,
    )!
    expect((listCall[0] as { where: Record<string, unknown> }).where).toEqual(expectedFilter)
    // count must use the same filter
    expect(mocks.prisma.userReview.count).toHaveBeenCalledWith({ where: expectedFilter })
  })

  it('excludeCurrentUser=true + authenticated: community summary is unchanged (does not exclude current user)', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
    await callGET('?excludeCurrentUser=true')

    // The summary findMany call has no skip/take — it pulls every approved row.
    const summaryCall = mocks.prisma.userReview.findMany.mock.calls.find(
      ([arg]) => (arg as { skip?: number })?.skip === undefined,
    )!
    const where = (summaryCall[0] as { where: Record<string, unknown> }).where
    expect(where).toEqual({ filmId: FILM_ID, status: 'approved' })
  })

  it('excludeCurrentUser=true + unauthenticated: param is a no-op, returns all reviews, no error', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue(null)
    const res = await callGET('?excludeCurrentUser=true')
    expect(res.status).toBe(200)

    expect(mocks.prisma.userReview.count).toHaveBeenCalledWith({
      where: { filmId: FILM_ID, status: 'approved' },
    })
    const listCall = mocks.prisma.userReview.findMany.mock.calls.find(
      ([arg]) => (arg as { skip?: number })?.skip !== undefined,
    )!
    const where = (listCall[0] as { where: Record<string, unknown> }).where
    expect(where).toEqual({ filmId: FILM_ID, status: 'approved' })
    expect(where).not.toHaveProperty('userId')
  })
})
