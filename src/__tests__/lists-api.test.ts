import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Mock dependencies before importing the route handlers
const mockGetMobileOrServerSession = vi.fn()
const mockListFindUnique = vi.fn()
const mockListFindFirst = vi.fn()
const mockListUpdate = vi.fn()
const mockListFilmDelete = vi.fn()

vi.mock('@/lib/mobile-auth', () => ({
  getMobileOrServerSession: (...args: unknown[]) => mockGetMobileOrServerSession(...args),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    list: {
      findUnique: (...args: unknown[]) => mockListFindUnique(...args),
      findFirst: (...args: unknown[]) => mockListFindFirst(...args),
      update: (...args: unknown[]) => mockListUpdate(...args),
    },
    listFilm: {
      delete: (...args: unknown[]) => mockListFilmDelete(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import { GET as publicGetList } from '@/app/api/lists/[id]/route'
import { PATCH as userPatchList } from '@/app/api/user/lists/[id]/route'
import { DELETE as userDeleteListFilm } from '@/app/api/user/lists/[id]/films/[filmId]/route'

function makeParams<T extends Record<string, string>>(obj: T): Promise<T> {
  return Promise.resolve(obj)
}

function makeJsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const baseListShape = {
  id: 'list-1',
  name: 'Favorites',
  genreTag: 'Drama',
  description: null,
  userId: 'owner-1',
  createdAt: new Date('2026-04-01T00:00:00Z'),
  updatedAt: new Date('2026-04-10T00:00:00Z'),
  user: { id: 'owner-1', name: 'Owner', username: 'owner', image: null },
  films: [],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/lists/[id] (public list detail)', () => {
  it('returns a public list to an anonymous visitor', async () => {
    mockListFindUnique.mockResolvedValue({ ...baseListShape, isPublic: true })

    const req = new NextRequest('http://localhost/api/lists/list-1')
    const res = await publicGetList(req, { params: makeParams({ id: 'list-1' }) })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.id).toBe('list-1')
    expect(data.name).toBe('Favorites')
    expect(data.isPublic).toBe(true)
    // Anonymous visitors don't need a session check for a public list
    expect(mockGetMobileOrServerSession).not.toHaveBeenCalled()
  })

  it('returns 404 when the list does not exist', async () => {
    mockListFindUnique.mockResolvedValue(null)

    const req = new NextRequest('http://localhost/api/lists/missing')
    const res = await publicGetList(req, { params: makeParams({ id: 'missing' }) })

    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toMatch(/not found/i)
  })

  it('denies a private list to a non-owner visitor (returns 404, not 403)', async () => {
    mockListFindUnique.mockResolvedValue({ ...baseListShape, isPublic: false })
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'someone-else', role: 'USER', email: 'x@y.z', name: 'Other', image: null },
    })

    const req = new NextRequest('http://localhost/api/lists/list-1')
    const res = await publicGetList(req, { params: makeParams({ id: 'list-1' }) })

    expect(res.status).toBe(404)
  })

  it('denies a private list to an unauthenticated visitor', async () => {
    mockListFindUnique.mockResolvedValue({ ...baseListShape, isPublic: false })
    mockGetMobileOrServerSession.mockResolvedValue(null)

    const req = new NextRequest('http://localhost/api/lists/list-1')
    const res = await publicGetList(req, { params: makeParams({ id: 'list-1' }) })

    expect(res.status).toBe(404)
  })

  it('returns a private list when the owner is authenticated', async () => {
    mockListFindUnique.mockResolvedValue({ ...baseListShape, isPublic: false })
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'owner-1', role: 'USER', email: 'owner@test', name: 'Owner', image: null },
    })

    const req = new NextRequest('http://localhost/api/lists/list-1')
    const res = await publicGetList(req, { params: makeParams({ id: 'list-1' }) })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.isPublic).toBe(false)
    expect(data.owner.id).toBe('owner-1')
  })
})

describe('PATCH /api/user/lists/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    mockGetMobileOrServerSession.mockResolvedValue(null)

    const req = makeJsonRequest('http://localhost/api/user/lists/list-1', 'PATCH', {
      name: 'New name',
    })
    const res = await userPatchList(req, { params: makeParams({ id: 'list-1' }) })

    expect(res.status).toBe(401)
  })

  it('returns 404 when the list is not owned by the caller', async () => {
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'owner-1', role: 'USER', email: 'x', name: 'x', image: null },
    })
    mockListFindFirst.mockResolvedValue(null)

    const req = makeJsonRequest('http://localhost/api/user/lists/list-1', 'PATCH', {
      name: 'New name',
    })
    const res = await userPatchList(req, { params: makeParams({ id: 'list-1' }) })

    expect(res.status).toBe(404)
  })

  it('renames a list owned by the caller', async () => {
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'owner-1', role: 'USER', email: 'x', name: 'x', image: null },
    })
    mockListFindFirst.mockResolvedValue({ id: 'list-1' })
    mockListUpdate.mockResolvedValue({
      id: 'list-1',
      name: 'Renamed',
      genreTag: 'Drama',
      description: null,
      isPublic: true,
      updatedAt: new Date(),
    })

    const req = makeJsonRequest('http://localhost/api/user/lists/list-1', 'PATCH', {
      name: '  Renamed  ',
    })
    const res = await userPatchList(req, { params: makeParams({ id: 'list-1' }) })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.name).toBe('Renamed')

    // Name is trimmed before being persisted
    expect(mockListUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'list-1' },
        data: expect.objectContaining({ name: 'Renamed' }),
      })
    )
  })

  it('rejects an empty name with 400', async () => {
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'owner-1', role: 'USER', email: 'x', name: 'x', image: null },
    })
    mockListFindFirst.mockResolvedValue({ id: 'list-1' })

    const req = makeJsonRequest('http://localhost/api/user/lists/list-1', 'PATCH', {
      name: '   ',
    })
    const res = await userPatchList(req, { params: makeParams({ id: 'list-1' }) })

    expect(res.status).toBe(400)
    expect(mockListUpdate).not.toHaveBeenCalled()
  })

  it('toggles privacy via isPublic', async () => {
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'owner-1', role: 'USER', email: 'x', name: 'x', image: null },
    })
    mockListFindFirst.mockResolvedValue({ id: 'list-1' })
    mockListUpdate.mockResolvedValue({
      id: 'list-1',
      name: 'Favorites',
      genreTag: null,
      description: null,
      isPublic: false,
      updatedAt: new Date(),
    })

    const req = makeJsonRequest('http://localhost/api/user/lists/list-1', 'PATCH', {
      isPublic: false,
    })
    const res = await userPatchList(req, { params: makeParams({ id: 'list-1' }) })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.isPublic).toBe(false)
    expect(mockListUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPublic: false }),
      })
    )
  })
})

describe('DELETE /api/user/lists/[listId]/films/[filmId]', () => {
  it('returns 401 when unauthenticated', async () => {
    mockGetMobileOrServerSession.mockResolvedValue(null)

    const req = new NextRequest('http://localhost/api/user/lists/list-1/films/film-1', {
      method: 'DELETE',
    })
    const res = await userDeleteListFilm(req, {
      params: makeParams({ id: 'list-1', filmId: 'film-1' }),
    })

    expect(res.status).toBe(401)
  })

  it('returns 404 when the list is not owned by the caller', async () => {
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'owner-1', role: 'USER', email: 'x', name: 'x', image: null },
    })
    mockListFindFirst.mockResolvedValue(null)

    const req = new NextRequest('http://localhost/api/user/lists/list-1/films/film-1', {
      method: 'DELETE',
    })
    const res = await userDeleteListFilm(req, {
      params: makeParams({ id: 'list-1', filmId: 'film-1' }),
    })

    expect(res.status).toBe(404)
    expect(mockListFilmDelete).not.toHaveBeenCalled()
  })

  it('removes the film and bumps the list updatedAt when owned by the caller', async () => {
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'owner-1', role: 'USER', email: 'x', name: 'x', image: null },
    })
    mockListFindFirst.mockResolvedValue({ id: 'list-1' })
    mockListFilmDelete.mockResolvedValue({})
    mockListUpdate.mockResolvedValue({})

    const req = new NextRequest('http://localhost/api/user/lists/list-1/films/film-1', {
      method: 'DELETE',
    })
    const res = await userDeleteListFilm(req, {
      params: makeParams({ id: 'list-1', filmId: 'film-1' }),
    })

    expect(res.status).toBe(200)
    expect(mockListFilmDelete).toHaveBeenCalledWith({
      where: { listId_filmId: { listId: 'list-1', filmId: 'film-1' } },
    })
    // Bump updatedAt so profile cards show the change
    expect(mockListUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'list-1' } })
    )
  })

  it('returns 404 if the film is not in the list', async () => {
    mockGetMobileOrServerSession.mockResolvedValue({
      user: { id: 'owner-1', role: 'USER', email: 'x', name: 'x', image: null },
    })
    mockListFindFirst.mockResolvedValue({ id: 'list-1' })
    mockListFilmDelete.mockRejectedValue(new Error('Record to delete does not exist.'))

    const req = new NextRequest('http://localhost/api/user/lists/list-1/films/film-1', {
      method: 'DELETE',
    })
    const res = await userDeleteListFilm(req, {
      params: makeParams({ id: 'list-1', filmId: 'film-1' }),
    })

    expect(res.status).toBe(404)
  })
})
