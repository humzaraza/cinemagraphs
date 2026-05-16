import { del, list } from '@vercel/blob'
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

export async function deleteAllUserBannerBlobs(userId: string): Promise<void> {
  const prefix = `banners/${userId}/`
  let cursor: string | undefined
  do {
    let page
    try {
      page = await list({ prefix, cursor })
    } catch (err) {
      apiLogger.warn({ err, userId, prefix }, 'Failed to list banner blobs for deletion')
      return
    }
    const urls = page.blobs.map((b) => b.url)
    if (urls.length > 0) {
      try {
        await del(urls)
      } catch (err) {
        apiLogger.warn({ err, userId, count: urls.length }, 'Failed to bulk-delete banner blobs')
      }
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
}

export function validateBannerBlobPath(path: unknown): boolean {
  if (typeof path !== 'string') return false
  if (path.length === 0) return false
  return path.startsWith('banners/')
}
