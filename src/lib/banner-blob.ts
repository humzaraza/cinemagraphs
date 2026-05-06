import { del } from '@vercel/blob'
import { apiLogger } from './logger'

export interface BannerOwner {
  id: string
  bannerType: string
  bannerValue: string
}

export async function deleteUserBannerBlob(user: BannerOwner): Promise<void> {
  if (user.bannerType !== 'PHOTO') return
  if (typeof user.bannerValue !== 'string' || user.bannerValue.length === 0) return

  try {
    await del(user.bannerValue)
  } catch (err) {
    apiLogger.warn(
      { err, userId: user.id, bannerValue: user.bannerValue },
      'Failed to delete previous banner blob'
    )
  }
}

export function validateBannerBlobPath(path: unknown): boolean {
  if (typeof path !== 'string') return false
  if (path.length === 0) return false
  return path.startsWith('banners/')
}
