import { del, list } from '@vercel/blob'
import { apiLogger } from './logger'

export async function deleteAllUserAvatarBlobs(userId: string): Promise<void> {
  const prefix = `avatars/${userId}`
  let cursor: string | undefined
  do {
    let page
    try {
      page = await list({ prefix, cursor })
    } catch (err) {
      apiLogger.warn({ err, userId, prefix }, 'Failed to list avatar blobs for deletion')
      return
    }
    const urls = page.blobs.map((b) => b.url)
    if (urls.length > 0) {
      try {
        await del(urls)
      } catch (err) {
        apiLogger.warn({ err, userId, count: urls.length }, 'Failed to bulk-delete avatar blobs')
      }
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
}
