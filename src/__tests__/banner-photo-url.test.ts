import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  loggerChild: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))

vi.mock('@/lib/logger', () => ({
  apiLogger: mocks.apiLogger,
  logger: { child: mocks.loggerChild },
}))

import { getBannerPhotoUrl } from '@/lib/banner-photo-url'

describe('getBannerPhotoUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns full https URL when BLOB_PUBLIC_HOST is set', () => {
    vi.stubEnv('BLOB_PUBLIC_HOST', 'auigaoon1c8jopru.public.blob.vercel-storage.com')
    const url = getBannerPhotoUrl('banners/user_1/abc-123.jpg')
    expect(url).toBe(
      'https://auigaoon1c8jopru.public.blob.vercel-storage.com/banners/user_1/abc-123.jpg'
    )
  })

  it('returns null and logs a warning when BLOB_PUBLIC_HOST is unset', () => {
    vi.stubEnv('BLOB_PUBLIC_HOST', '')
    const url = getBannerPhotoUrl('banners/user_1/abc-123.jpg')
    expect(url).toBeNull()
    expect(mocks.apiLogger.warn).toHaveBeenCalled()
  })

  it('does not URL-encode the pathname (blob CDN handles it)', () => {
    vi.stubEnv('BLOB_PUBLIC_HOST', 'cdn.example.com')
    const url = getBannerPhotoUrl('banners/user 1/file with spaces.jpg')
    expect(url).toBe('https://cdn.example.com/banners/user 1/file with spaces.jpg')
  })

  it('preserves random suffix segments produced by addRandomSuffix', () => {
    vi.stubEnv('BLOB_PUBLIC_HOST', 'cdn.example.com')
    const url = getBannerPhotoUrl('banners/user_1/avatar-Hg9k2x.jpg')
    expect(url).toBe('https://cdn.example.com/banners/user_1/avatar-Hg9k2x.jpg')
  })
})
