import { describe, it, expect, vi, beforeEach } from 'vitest'
// Nullable Json columns take Prisma.DbNull for SQL NULL; a stored "null"
// beatRatings reaches the client as this sentinel and reads back as null.
import { Prisma } from '@/generated/prisma/client'

const mocks = vi.hoisted(() => ({
  prisma: {
    film: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    userReview: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  apiLogger: { error: vi.fn() },
  getMobileOrServerSession: vi.fn(),
  extractSentiment: vi.fn(),
  maybeBlendAndUpdate: vi.fn(),
  checkSuspension: vi.fn(),
  invalidateFilmCache: vi.fn(),
  logActivity: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))
vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/sentiment-extract', () => ({ extractSentiment: mocks.extractSentiment }))
vi.mock('@/lib/review-blender', () => ({ maybeBlendAndUpdate: mocks.maybeBlendAndUpdate }))
vi.mock('@/lib/middleware', () => ({ checkSuspension: mocks.checkSuspension }))
vi.mock('@/lib/cache', () => ({ invalidateFilmCache: mocks.invalidateFilmCache }))
vi.mock('@/lib/activity', () => ({ logActivity: mocks.logActivity }))

const FILM_ID = 'film-1'
const USER_ID = 'me'

// The film's graph carries these beat labels; anything else is unknown.
const GRAPH_LABELS = ['Opening', 'Climax', 'Finale']

// Accepts a pre-encoded string so tests can send bodies JSON.stringify
// cannot produce (for example 1e999, which parses back as Infinity).
async function callPOSTRaw(rawBody: string) {
  const { POST } = await import('@/app/api/films/[id]/reviews/route')
  const request = new Request(`http://localhost/api/films/${FILM_ID}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  })
  // The route signature expects NextRequest; a plain Request works at runtime
  // because POST only reads json().
  return POST(request as unknown as Parameters<typeof POST>[0], {
    params: Promise.resolve({ id: FILM_ID }),
  })
}

async function callPOST(body: Record<string, unknown>) {
  return callPOSTRaw(JSON.stringify(body))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
  mocks.checkSuspension.mockResolvedValue(null)
  mocks.prisma.film.findUnique.mockResolvedValue({
    id: FILM_ID,
    sentimentGraph: {
      dataPoints: GRAPH_LABELS.map((label, i) => ({
        timeStart: i,
        timeEnd: i + 1,
        timeMidpoint: i + 0.5,
        score: 7,
        label,
        confidence: 'high',
        reviewEvidence: '',
      })),
    },
    filmBeats: null,
  })
  mocks.prisma.user.findUnique.mockResolvedValue({ createdAt: new Date('2025-01-01') })
  mocks.prisma.userReview.findUnique.mockResolvedValue(null)
  mocks.prisma.userReview.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'review-1',
    status: data.status,
    ...data,
    user: { id: USER_ID, name: 'Me', image: null },
  }))
  mocks.prisma.userReview.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'review-1',
    ...data,
    user: { id: USER_ID, name: 'Me', image: null },
  }))
  mocks.extractSentiment.mockResolvedValue(null)
  // The route chains .catch() on these fire-and-forget calls.
  mocks.invalidateFilmCache.mockResolvedValue(undefined)
  mocks.maybeBlendAndUpdate.mockResolvedValue(undefined)
  mocks.logActivity.mockResolvedValue(undefined)
})

function createdBeatRatings() {
  expect(mocks.prisma.userReview.create).toHaveBeenCalledTimes(1)
  const { data } = mocks.prisma.userReview.create.mock.calls[0][0] as {
    data: { beatRatings: Record<string, number> | null }
  }
  return data.beatRatings
}

describe('POST /api/films/[id]/reviews — beatRatings normalization', () => {
  it('stores null when beatRatings is an empty object', async () => {
    const res = await callPOST({ overallRating: 7, beatRatings: {} })
    expect(res.status).toBe(201)
    expect(createdBeatRatings()).toBe(Prisma.DbNull)
  })

  it('stores null when every key gets filtered out as unknown', async () => {
    const res = await callPOST({
      overallRating: 7,
      beatRatings: { 'Stale Beat': 6, 'Another Stale Beat': 8 },
    })
    expect(res.status).toBe(201)
    expect(createdBeatRatings()).toBe(Prisma.DbNull)
  })

  it('drops unknown keys while valid ones survive', async () => {
    const res = await callPOST({
      overallRating: 7,
      beatRatings: { Opening: 8, 'Stale Beat': 5, Climax: 3.5 },
    })
    expect(res.status).toBe(201)
    expect(createdBeatRatings()).toEqual({ Opening: 8, Climax: 3.5 })
  })

  it('stores a fully valid map unchanged', async () => {
    const res = await callPOST({
      overallRating: 7,
      beatRatings: { Opening: 1, Climax: 5.5, Finale: 10 },
    })
    expect(res.status).toBe(201)
    expect(createdBeatRatings()).toEqual({ Opening: 1, Climax: 5.5, Finale: 10 })
  })

  it('rejects a non-object beatRatings with 400', async () => {
    const res = await callPOST({ overallRating: 7, beatRatings: 'all great' })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Beat ratings must be an object mapping beat labels to scores')
    expect(mocks.prisma.userReview.create).not.toHaveBeenCalled()
  })

  it('rejects an array beatRatings with 400', async () => {
    const res = await callPOST({ overallRating: 7, beatRatings: [8, 9] })
    expect(res.status).toBe(400)
    expect(mocks.prisma.userReview.create).not.toHaveBeenCalled()
  })

  it('rejects an above-range value with 400', async () => {
    const res = await callPOST({ overallRating: 7, beatRatings: { Opening: 10.5 } })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Beat rating for "Opening" must be between 1 and 10')
    expect(mocks.prisma.userReview.create).not.toHaveBeenCalled()
  })

  it('rejects a below-range value with 400', async () => {
    const res = await callPOST({ overallRating: 7, beatRatings: { Opening: 0.5 } })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Beat rating for "Opening" must be between 1 and 10')
    expect(mocks.prisma.userReview.create).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric value with 400', async () => {
    const res = await callPOST({ overallRating: 7, beatRatings: { Climax: 'loved it' } })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Beat rating for "Climax" must be a number')
    expect(mocks.prisma.userReview.create).not.toHaveBeenCalled()
  })

  it('rejects a null value inside the map with 400', async () => {
    const res = await callPOST({ overallRating: 7, beatRatings: { Opening: null } })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Beat rating for "Opening" must be a number')
    expect(mocks.prisma.userReview.create).not.toHaveBeenCalled()
  })

  it('rejects a non-finite value with 400', async () => {
    // JSON.parse turns 1e999 into Infinity, so a raw body reaches the
    // Number.isFinite guard with a value typeof number that is not finite.
    const res = await callPOSTRaw('{"overallRating":7,"beatRatings":{"Opening":1e999}}')
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Beat rating for "Opening" must be a number')
    expect(mocks.prisma.userReview.create).not.toHaveBeenCalled()
  })

  it('treats an explicit top-level null beatRatings as absent and stores null', async () => {
    const res = await callPOST({ overallRating: 7, beatRatings: null })
    expect(res.status).toBe(201)
    expect(createdBeatRatings()).toBe(Prisma.DbNull)
  })

  it('stores null on the edit path too when the filtered map is empty', async () => {
    mocks.prisma.userReview.findUnique.mockResolvedValue({ id: 'review-1' })
    const res = await callPOST({ overallRating: 7, beatRatings: { 'Stale Beat': 6 } })
    expect(res.status).toBe(200)
    expect(mocks.prisma.userReview.update).toHaveBeenCalledTimes(1)
    const { data } = mocks.prisma.userReview.update.mock.calls[0][0] as {
      data: { beatRatings: Record<string, number> | null }
    }
    expect(data.beatRatings).toBe(Prisma.DbNull)
  })

  it('accepts wiki filmBeats labels when the film has no sentiment graph', async () => {
    // Mirrors the film page: with no graph, the composer offers wiki-sourced
    // filmBeats sliders, so those labels must be storable.
    mocks.prisma.film.findUnique.mockResolvedValue({
      id: FILM_ID,
      sentimentGraph: null,
      filmBeats: { beats: [{ label: 'The Heist' }, { label: 'The Escape' }] },
    })
    const res = await callPOST({
      overallRating: 7,
      beatRatings: { 'The Heist': 8, 'Stale Beat': 5 },
    })
    expect(res.status).toBe(201)
    expect(createdBeatRatings()).toEqual({ 'The Heist': 8 })
  })

  it('treats a film with no graph and no filmBeats as having no valid labels', async () => {
    mocks.prisma.film.findUnique.mockResolvedValue({
      id: FILM_ID,
      sentimentGraph: null,
      filmBeats: null,
    })
    const res = await callPOST({ overallRating: 7, beatRatings: { Opening: 8 } })
    expect(res.status).toBe(201)
    expect(createdBeatRatings()).toBe(Prisma.DbNull)
  })

  it('stores null when beatRatings is absent', async () => {
    const res = await callPOST({ overallRating: 7 })
    expect(res.status).toBe(201)
    expect(createdBeatRatings()).toBe(Prisma.DbNull)
  })
})
