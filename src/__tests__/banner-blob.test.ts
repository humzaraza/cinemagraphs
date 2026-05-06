import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  del: vi.fn(),
  apiLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock('@vercel/blob', () => ({ del: mocks.del }))
vi.mock('@/lib/logger', () => ({ apiLogger: mocks.apiLogger }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.del.mockResolvedValue(undefined)
})

describe('deleteUserBannerBlob', () => {
  it('calls del() when bannerType is PHOTO and bannerValue is non-empty', async () => {
    const { deleteUserBannerBlob } = await import('@/lib/banner-blob')
    await deleteUserBannerBlob({
      id: 'user_1',
      bannerType: 'PHOTO',
      bannerValue: 'banners/user_1/123.jpg',
    })
    expect(mocks.del).toHaveBeenCalledWith('banners/user_1/123.jpg')
    expect(mocks.apiLogger.warn).not.toHaveBeenCalled()
  })

  it('is a no-op when bannerType is GRADIENT', async () => {
    const { deleteUserBannerBlob } = await import('@/lib/banner-blob')
    await deleteUserBannerBlob({
      id: 'user_1',
      bannerType: 'GRADIENT',
      bannerValue: 'midnight',
    })
    expect(mocks.del).not.toHaveBeenCalled()
  })

  it('is a no-op when bannerType is BACKDROP', async () => {
    const { deleteUserBannerBlob } = await import('@/lib/banner-blob')
    await deleteUserBannerBlob({
      id: 'user_1',
      bannerType: 'BACKDROP',
      bannerValue: 'film_xyz',
    })
    expect(mocks.del).not.toHaveBeenCalled()
  })

  it('is a no-op when bannerValue is empty', async () => {
    const { deleteUserBannerBlob } = await import('@/lib/banner-blob')
    await deleteUserBannerBlob({
      id: 'user_1',
      bannerType: 'PHOTO',
      bannerValue: '',
    })
    expect(mocks.del).not.toHaveBeenCalled()
  })

  it('logs and resolves when del() throws', async () => {
    mocks.del.mockRejectedValue(new Error('blob gone'))
    const { deleteUserBannerBlob } = await import('@/lib/banner-blob')
    await expect(
      deleteUserBannerBlob({
        id: 'user_1',
        bannerType: 'PHOTO',
        bannerValue: 'banners/user_1/abc.jpg',
      })
    ).resolves.toBeUndefined()
    expect(mocks.apiLogger.warn).toHaveBeenCalledTimes(1)
    const [meta] = mocks.apiLogger.warn.mock.calls[0]
    expect(meta).toMatchObject({
      userId: 'user_1',
      bannerValue: 'banners/user_1/abc.jpg',
    })
  })
})

describe('validateBannerBlobPath', () => {
  it('returns true for a path under banners/', async () => {
    const { validateBannerBlobPath } = await import('@/lib/banner-blob')
    expect(validateBannerBlobPath('banners/user_1/abc.jpg')).toBe(true)
  })

  it('returns false for an empty string', async () => {
    const { validateBannerBlobPath } = await import('@/lib/banner-blob')
    expect(validateBannerBlobPath('')).toBe(false)
  })

  it('returns false for a path outside banners/', async () => {
    const { validateBannerBlobPath } = await import('@/lib/banner-blob')
    expect(validateBannerBlobPath('avatars/user_1/abc.jpg')).toBe(false)
  })

  it('returns false for a path that does not start at the root with banners/', async () => {
    const { validateBannerBlobPath } = await import('@/lib/banner-blob')
    expect(validateBannerBlobPath('/banners/user_1/abc.jpg')).toBe(false)
  })

  it('returns false for non-string input', async () => {
    const { validateBannerBlobPath } = await import('@/lib/banner-blob')
    expect(validateBannerBlobPath(undefined)).toBe(false)
    expect(validateBannerBlobPath(null)).toBe(false)
    expect(validateBannerBlobPath(42)).toBe(false)
  })
})
