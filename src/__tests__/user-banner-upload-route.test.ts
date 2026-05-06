import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getMobileOrServerSession: vi.fn(),
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  handleUpload: vi.fn(),
  prisma: { user: { update: vi.fn() } },
}))

vi.mock('@vercel/blob/client', () => ({ handleUpload: mocks.handleUpload }))
vi.mock('@/lib/mobile-auth', () => ({ getMobileOrServerSession: mocks.getMobileOrServerSession }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))

const USER_ID = 'user_1'

function uploadRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/user/banner/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const TOKEN_BODY = {
  type: 'blob.generate-client-token',
  payload: { pathname: 'banners/user_1/123.jpg', multipart: false, clientPayload: null },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMobileOrServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'USER' } })
  mocks.handleUpload.mockResolvedValue({ type: 'blob.generate-client-token', clientToken: 'tok_abc' })
})

describe('POST /api/user/banner/upload', () => {
  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/user/banner/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    const { POST } = await import('@/app/api/user/banner/upload/route')
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(mocks.handleUpload).not.toHaveBeenCalled()
  })

  it('returns the handleUpload result on success', async () => {
    const { POST } = await import('@/app/api/user/banner/upload/route')
    const res = await POST(uploadRequest(TOKEN_BODY))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ type: 'blob.generate-client-token', clientToken: 'tok_abc' })
    expect(mocks.handleUpload).toHaveBeenCalledTimes(1)
  })

  describe('onBeforeGenerateToken', () => {
    async function runOnBefore(pathname: string) {
      let captured: { onBeforeGenerateToken?: unknown } = {}
      mocks.handleUpload.mockImplementation(async (opts: { onBeforeGenerateToken: unknown }) => {
        captured = opts
        const fn = opts.onBeforeGenerateToken as (
          pathname: string,
          payload: string | null,
          multipart: boolean
        ) => Promise<unknown>
        return await fn(pathname, null, false)
      })
      const { POST } = await import('@/app/api/user/banner/upload/route')
      const res = await POST(uploadRequest(TOKEN_BODY))
      return { res, captured }
    }

    it('returns 401 when no session is present', async () => {
      mocks.getMobileOrServerSession.mockResolvedValue(null)
      const { res } = await runOnBefore('banners/user_1/123.jpg')
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Authentication required')
    })

    it('returns 400 when the pathname does not start with banners/<userId>/', async () => {
      const { res } = await runOnBefore('avatars/user_1/123.jpg')
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('banners/user_1/')
    })

    it('returns 400 when the pathname targets a different user', async () => {
      const { res } = await runOnBefore('banners/user_other/123.jpg')
      expect(res.status).toBe(400)
    })

    it('issues a token with the locked content-type and size constraints', async () => {
      let captured: unknown
      mocks.handleUpload.mockImplementation(async (opts: { onBeforeGenerateToken: unknown }) => {
        const fn = opts.onBeforeGenerateToken as (
          pathname: string,
          payload: string | null,
          multipart: boolean
        ) => Promise<{
          allowedContentTypes?: string[]
          maximumSizeInBytes?: number
          addRandomSuffix?: boolean
          tokenPayload?: string | null
        }>
        captured = await fn('banners/user_1/123.jpg', null, false)
        return { type: 'blob.generate-client-token', clientToken: 'tok_abc' }
      })
      const { POST } = await import('@/app/api/user/banner/upload/route')
      const res = await POST(uploadRequest(TOKEN_BODY))
      expect(res.status).toBe(200)
      const opts = captured as {
        allowedContentTypes: string[]
        maximumSizeInBytes: number
        addRandomSuffix: boolean
        tokenPayload: string
      }
      expect(opts.allowedContentTypes).toEqual(['image/jpeg', 'image/png'])
      expect(opts.maximumSizeInBytes).toBe(5 * 1024 * 1024)
      expect(opts.addRandomSuffix).toBe(true)
      const parsed = JSON.parse(opts.tokenPayload)
      expect(parsed.userId).toBe(USER_ID)
    })
  })

  describe('onUploadCompleted', () => {
    async function runOnCompleted(payload: { blob: { pathname: string; contentType: string; url: string }; tokenPayload: string | null }) {
      mocks.handleUpload.mockImplementation(async (opts: { onUploadCompleted?: unknown }) => {
        const fn = opts.onUploadCompleted as ((p: typeof payload) => Promise<void>) | undefined
        if (fn) await fn(payload)
        return { type: 'blob.upload-completed', response: 'ok' }
      })
      const { POST } = await import('@/app/api/user/banner/upload/route')
      return await POST(uploadRequest(TOKEN_BODY))
    }

    it('logs success at info level with userId from tokenPayload', async () => {
      const res = await runOnCompleted({
        blob: { pathname: 'banners/user_1/abc.jpg', contentType: 'image/jpeg', url: 'https://blob.example/banners/user_1/abc.jpg' },
        tokenPayload: JSON.stringify({ userId: USER_ID }),
      })
      expect(res.status).toBe(200)
      expect(mocks.apiLogger.info).toHaveBeenCalledTimes(1)
      const [meta, msg] = mocks.apiLogger.info.mock.calls[0]
      expect(meta).toMatchObject({
        userId: USER_ID,
        pathname: 'banners/user_1/abc.jpg',
        contentType: 'image/jpeg',
      })
      expect(msg).toBe('Banner blob upload completed')
    })

    it('does not update the User record', async () => {
      await runOnCompleted({
        blob: { pathname: 'banners/user_1/abc.jpg', contentType: 'image/jpeg', url: 'https://blob.example/banners/user_1/abc.jpg' },
        tokenPayload: JSON.stringify({ userId: USER_ID }),
      })
      expect(mocks.prisma.user.update).not.toHaveBeenCalled()
    })

    it('logs with userId=null when tokenPayload is missing', async () => {
      await runOnCompleted({
        blob: { pathname: 'banners/user_1/abc.jpg', contentType: 'image/jpeg', url: 'https://blob.example/banners/user_1/abc.jpg' },
        tokenPayload: null,
      })
      expect(mocks.apiLogger.info).toHaveBeenCalledTimes(1)
      const [meta] = mocks.apiLogger.info.mock.calls[0]
      expect(meta).toMatchObject({ userId: null })
    })
  })
})
