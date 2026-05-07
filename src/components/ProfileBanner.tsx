'use client'

/**
 * Profile banner header for the web Profile page.
 *
 * Renders one of three banner types stored on the User record:
 *   - GRADIENT: a CSS linear-gradient preset, key in bannerValue
 *   - BACKDROP: a TMDB still chosen via the banner picker. bannerValue is
 *     JSON-encoded { filmId, backdropPath }. Non-null backdropPath uses
 *     the TMDB CDN directly; null falls back to the Film's default
 *     backdropUrl, which the server hydrates into bannerFilm so the
 *     client doesn't need a second round trip.
 *   - PHOTO: a custom image upload. bannerValue is the Vercel Blob
 *     pathname; the public CDN URL is constructed via getBannerPhotoUrl.
 *
 * Aspect: 16:9 to preserve the user's WYSIWYG crop choice from mobile.
 * On viewports >=768px, capped at max-h-[280px] (~3.5:1 letterbox at the
 * page's max-w-5xl content width) so the banner doesn't visually
 * dominate the desktop layout. Mobile keeps the full 16:9 because that
 * is what the user sees in the picker.
 *
 * Any failure mode (missing env, parse error, missing CDN URL, missing
 * fallback film) collapses to a default GRADIENT to avoid leaving an
 * empty rectangle or a broken <img>.
 */
import { parseBackdropBannerValue } from '@/lib/banner-validation'
import { getBackdropUrl } from '@/lib/tmdb-url'
import { getBannerPhotoUrl } from '@/lib/banner-photo-url'

const GRADIENT_PRESETS: Record<string, string> = {
  midnight: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%)',
  ember: 'linear-gradient(135deg, #7c2d12 0%, #b45309 50%, #f59e0b 100%)',
  ocean: 'linear-gradient(135deg, #0c4a6e 0%, #0e7490 50%, #14b8a6 100%)',
  dusk: 'linear-gradient(135deg, #4c1d95 0%, #be185d 50%, #f97316 100%)',
  forest: 'linear-gradient(135deg, #14532d 0%, #166534 50%, #65a30d 100%)',
  gold: 'linear-gradient(135deg, #78350f 0%, #b45309 50%, #c8a951 100%)',
  rose: 'linear-gradient(135deg, #881337 0%, #be123c 50%, #f472b6 100%)',
  steel: 'linear-gradient(135deg, #1e293b 0%, #475569 50%, #94a3b8 100%)',
}

const DEFAULT_GRADIENT = GRADIENT_PRESETS.midnight

const BANNER_FRAME_CLASS =
  'w-full aspect-[16/9] md:max-h-[280px] overflow-hidden rounded-lg mb-6 bg-cinema-darker'

interface ProfileBannerProps {
  loading: boolean
  bannerType: string | null | undefined
  bannerValue: string | null | undefined
  bannerFilm: { backdropUrl: string | null } | null | undefined
}

export default function ProfileBanner({
  loading,
  bannerType,
  bannerValue,
  bannerFilm,
}: ProfileBannerProps) {
  if (loading) {
    return (
      <div
        className={`${BANNER_FRAME_CLASS} animate-pulse`}
        aria-hidden="true"
      />
    )
  }

  const gradientFallback = (
    <div
      className={BANNER_FRAME_CLASS}
      style={{ background: DEFAULT_GRADIENT }}
      aria-hidden="true"
    />
  )

  if (!bannerType || !bannerValue) {
    return gradientFallback
  }

  if (bannerType === 'GRADIENT') {
    const preset = GRADIENT_PRESETS[bannerValue] ?? DEFAULT_GRADIENT
    return (
      <div
        className={BANNER_FRAME_CLASS}
        style={{ background: preset }}
        aria-hidden="true"
      />
    )
  }

  if (bannerType === 'BACKDROP') {
    const parsed = parseBackdropBannerValue(bannerValue)
    if (!parsed.ok) return gradientFallback

    const src = parsed.value.backdropPath
      ? getBackdropUrl(parsed.value.backdropPath, 'w1280')
      : bannerFilm?.backdropUrl
        ? getBackdropUrl(bannerFilm.backdropUrl, 'w1280')
        : null

    if (!src) return gradientFallback

    return (
      <div className={BANNER_FRAME_CLASS}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className="w-full h-full object-cover" />
      </div>
    )
  }

  if (bannerType === 'PHOTO') {
    const src = getBannerPhotoUrl(bannerValue)
    if (!src) return gradientFallback
    return (
      <div className={BANNER_FRAME_CLASS}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className="w-full h-full object-cover" />
      </div>
    )
  }

  return gradientFallback
}
