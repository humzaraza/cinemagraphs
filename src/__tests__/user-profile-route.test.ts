import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getMobileOrServerSession: vi.fn(),
  prisma: {
    user: { findUnique: vi.fn() },
    userReview: { findMany: vi.fn() },
    list: { findMany: vi.fn() },
    film: { findMany: vi.fn() },
  },
  apiLogger: { error: vi.fn() },
}))

vi.mock('@/lib/mobile-auth', () => ({
  getMobileOrServerSession: mocks.getMobileOrServerSession,
}))
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))

const USER_ID = 'user_1'
const DATA_POINTS = [
  { timeStart: 0, timeEnd: 30, timeMidpoint: 15, score: 6, label: 'Setup', confidence: 'medium', reviewEvidence: '' },
  { timeStart: 30, timeEnd: 60, timeMidpoint: 45, score: 7, label: 'Climax', confidence: 'medium', reviewEvidence: '' },
]

const userBase = {
  id: USER_ID,
  name: 'Alice',
  username: 'alice',
  bio: 'hi',
  image: null,
  email: 'a@b.com',
  role: 'USER',
  createdAt: new Date('2026-01-01'),
  bannerType: 'GRADIENT',
  bannerValue: 'midnight',
  favoriteFilms: [] as string[],
  _count: {
    userReviews: 0,
    watchlistItems: 0,
    lists: 0,
    following: 0,
    followers: 0,
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
  mocks.prisma.user.findUnique.mockResolvedValue({ ...userBase })
  mocks.prisma.userReview.findMany.mockResolvedValue([])
  mocks.prisma.list.findMany.mockResolvedValue([])
  mocks.prisma.film.findMany.mockResolvedValue([])
})

describe('GET /api/user/profile', () => {
  it('returns 401 when unauthenticated', async () => {
    mocks.getMobileOrServerSession.mockResolvedValue(null)
    const { GET } = await import('@/app/api/user/profile/route')
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user row is missing', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/user/profile/route')
    const res = await GET()
    expect(res.status).toBe(404)
  })

  it('returns the new shape with banner fields, recentReviews, and lists', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      ...userBase,
      bannerType: 'GRADIENT',
      bannerValue: 'ember',
      favoriteFilms: ['film_a'],
      _count: { userReviews: 3, watchlistItems: 2, lists: 1, following: 5, followers: 7 },
    })
    mocks.prisma.film.findMany.mockResolvedValue([
      {
        id: 'film_a',
        title: 'A',
        releaseDate: new Date('2024-06-15'),
        posterUrl: 'https://img/a.jpg',
        sentimentGraph: { dataPoints: DATA_POINTS },
      },
    ])
    mocks.prisma.userReview.findMany
      .mockResolvedValueOnce([{ filmId: 'film_a', beatRatings: { Climax: 9 } }]) // hydrateFavoriteFilms
      .mockResolvedValueOnce([
        {
          overallRating: 8.5,
          beatRatings: { Setup: 8 },
          film: {
            id: 'film_b',
            title: 'B',
            releaseDate: new Date('2023-03-01'),
            director: 'Director B',
            posterUrl: 'https://img/b.jpg',
            backdropUrl: 'https://img/b-bd.jpg',
            sentimentGraph: { dataPoints: DATA_POINTS },
          },
        },
      ])
    mocks.prisma.list.findMany.mockResolvedValue([
      {
        id: 'list_1',
        name: 'My favorites',
        _count: { films: 5 },
        films: [
          { film: { posterUrl: 'p1' } },
          { film: { posterUrl: 'p2' } },
          { film: { posterUrl: 'p3' } },
          { film: { posterUrl: 'p4' } },
        ],
      },
    ])

    const { GET } = await import('@/app/api/user/profile/route')
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.user.bannerType).toBe('GRADIENT')
    expect(body.user.bannerValue).toBe('ember')
    expect(body.user.favoriteFilms).toHaveLength(1)
    expect(body.user.favoriteFilms[0]).toEqual({
      id: 'film_a',
      title: 'A',
      year: 2024,
      posterUrl: 'https://img/a.jpg',
      sparklinePoints: [6, 9],
    })

    expect(body.stats).toEqual({
      reviewCount: 3,
      watchedCount: 3,
      watchlistCount: 2,
      listCount: 1,
      followingCount: 5,
      followerCount: 7,
    })

    expect(body.recentReviews).toHaveLength(1)
    expect(body.recentReviews[0]).toEqual({
      filmId: 'film_b',
      title: 'B',
      year: 2023,
      director: 'Director B',
      posterUrl: 'https://img/b.jpg',
      backdropUrl: 'https://img/b-bd.jpg',
      score: 8.5,
      sparklinePoints: [8, 7],
    })

    expect(body.lists).toEqual([
      {
        id: 'list_1',
        name: 'My favorites',
        filmCount: 5,
        mosaicPosters: ['p1', 'p2', 'p3', 'p4'],
      },
    ])
  })

  it('produces mosaicPosters in (p1,p2,p1,p2) pattern when list has 2 films', async () => {
    mocks.prisma.list.findMany.mockResolvedValue([
      {
        id: 'list_2',
        name: 'Short',
        _count: { films: 2 },
        films: [{ film: { posterUrl: 'p1' } }, { film: { posterUrl: 'p2' } }],
      },
    ])
    const { GET } = await import('@/app/api/user/profile/route')
    const res = await GET()
    const body = await res.json()
    expect(body.lists[0].mosaicPosters).toEqual(['p1', 'p2', 'p1', 'p2'])
  })

  it('returns sparklinePoints: [] for a recent review whose film has no sentimentGraph', async () => {
    mocks.prisma.userReview.findMany.mockResolvedValue([
      {
        overallRating: 7,
        beatRatings: { Setup: 8 },
        film: {
          id: 'film_c',
          title: 'C',
          releaseDate: null,
          director: null,
          posterUrl: null,
          backdropUrl: null,
          sentimentGraph: null,
        },
      },
    ])
    const { GET } = await import('@/app/api/user/profile/route')
    const res = await GET()
    const body = await res.json()
    expect(body.recentReviews[0].sparklinePoints).toEqual([])
    expect(body.recentReviews[0].year).toBeNull()
  })
})
