/**
 * Construct a public CDN URL for a PHOTO banner from its stored
 * Vercel Blob pathname.
 *
 * Why this exists: PHOTO banner uploads use the
 * `@vercel/blob/client` `handleUpload` flow (PR 1b), which writes
 * the file under a `banners/<userId>/...` pathname. The PATCH
 * /api/user/banner route persists this pathname only (validated by
 * `validateBannerBlobPath`). To render, we have to reconstruct the
 * full CDN URL from the pathname + the public host.
 *
 * Avatars do NOT use this helper. The avatar route
 * (src/app/api/user/avatar/route.ts) does a server-side `put()` and
 * stores the resulting full URL in `user.image`. Different storage
 * convention, deliberate, do not change.
 *
 * BLOB_PUBLIC_HOST env var: set in Vercel and .env.local, e.g.
 *   BLOB_PUBLIC_HOST=auigaoon1c8jopru.public.blob.vercel-storage.com
 *
 * If the env var is missing at runtime, we log and return null so the
 * render path can fall back to a gradient rather than emit a broken
 * <img src>. The pathname is appended verbatim; the blob CDN handles
 * percent-encoding.
 */
import { apiLogger } from './logger'

export function getBannerPhotoUrl(bannerValue: string): string | null {
  const host = process.env.BLOB_PUBLIC_HOST
  if (!host || host.length === 0) {
    apiLogger.warn(
      { bannerValue },
      'BLOB_PUBLIC_HOST env var is missing; cannot construct PHOTO banner URL'
    )
    return null
  }
  return `https://${host}/${bannerValue}`
}
