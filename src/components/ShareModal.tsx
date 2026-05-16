'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'

interface Props {
  reviewId: string
  filmTitle: string
  onClose: () => void
}

type StyleChoice = 'graph-hero' | 'cinematic'

interface StyleImage {
  url: string
  blob: Blob
}

const STYLE_LABELS: Record<StyleChoice, string> = {
  'graph-hero': 'Graph Hero',
  'cinematic': 'Cinematic',
}

const STYLE_DIMS: Record<StyleChoice, { w: number; h: number }> = {
  'graph-hero': { w: 1080, h: 1920 },
  'cinematic': { w: 1080, h: 608 },
}

export default function ShareModal({ reviewId, filmTitle, onClose }: Props) {
  const [activeStyle, setActiveStyle] = useState<StyleChoice>('graph-hero')
  const [images, setImages] = useState<Record<StyleChoice, StyleImage | null>>({
    'graph-hero': null,
    'cinematic': null,
  })
  const [pendingCount, setPendingCount] = useState(2)
  const [error, setError] = useState<string | null>(null)

  const generate = useCallback(async () => {
    setPendingCount(2)
    setError(null)
    setImages({ 'graph-hero': null, 'cinematic': null })

    const styles: StyleChoice[] = ['graph-hero', 'cinematic']

    await Promise.all(
      styles.map(async (style) => {
        try {
          const res = await fetch(`/api/share/review/${reviewId}?style=${style}`)
          if (!res.ok) {
            const text = await res.text()
            console.error(`[ShareModal] ${style} error:`, res.status, text)
            return
          }
          const ct = res.headers.get('content-type') || ''
          if (!ct.includes('image')) {
            console.error(`[ShareModal] ${style}: expected image, got ${ct}`)
            return
          }
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          setImages((prev) => ({ ...prev, [style]: { url, blob } }))
        } catch (err) {
          console.error(`[ShareModal] ${style} fetch failed:`, err)
        } finally {
          setPendingCount((prev) => prev - 1)
        }
      })
    )
  }, [reviewId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO(lint): fetch-on-mount pattern; revisit when migrating to Suspense or React Query
    generate()
  }, [generate])

  const activeImage = images[activeStyle]
  const anyImage = images['graph-hero'] || images['cinematic']
  const allDone = pendingCount <= 0
  const stillLoading = !allDone && !activeImage

  // Phase: loading if nothing yet, preview if any image loaded, error if all done and nothing
  const phase = !anyImage && !allDone ? 'loading' : anyImage ? 'preview' : 'error'

  const handleShare = async () => {
    if (!activeImage) return
    const file = new File([activeImage.blob], 'my-review.png', { type: 'image/png' })
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: `My ${filmTitle} review on Cinemagraphs`,
        })
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.error('Share failed:', err)
        }
      }
    }
  }

  const handleSave = () => {
    if (!activeImage) return
    const a = document.createElement('a')
    a.href = activeImage.url
    a.download = `${filmTitle.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-review-${activeStyle}.png`
    a.click()
  }

  const canNativeShare = typeof navigator !== 'undefined' && !!navigator.share
  const dims = STYLE_DIMS[activeStyle]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto"
        style={{
          backgroundColor: 'var(--cinema-card)',
          border: '1px solid rgba(200,169,110,0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold text-cinema-cream">
            Share Your Review
          </h2>
          <button
            onClick={onClose}
            className="text-cinema-muted hover:text-cinema-cream transition-colors text-lg"
          >
            ✕
          </button>
        </div>

        {/* Style Toggle */}
        {phase !== 'loading' && (
          <div className="flex gap-2 mb-4">
            {(['graph-hero', 'cinematic'] as StyleChoice[]).map((style) => {
              const isActive = activeStyle === style
              const hasFailed = allDone && !images[style]
              return (
                <button
                  key={style}
                  onClick={() => setActiveStyle(style)}
                  disabled={hasFailed}
                  className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                  style={{
                    backgroundColor: isActive ? 'rgba(200,169,110,0.15)' : 'transparent',
                    border: `1px solid ${isActive ? 'rgba(200,169,110,0.5)' : 'rgba(255,255,255,0.08)'}`,
                    color: hasFailed
                      ? 'rgba(255,255,255,0.2)'
                      : isActive
                        ? '#c8a96e'
                        : 'rgba(255,255,255,0.4)',
                    cursor: hasFailed ? 'not-allowed' : 'pointer',
                  }}
                >
                  {STYLE_LABELS[style]}
                </button>
              )
            })}
          </div>
        )}

        {/* Loading */}
        {phase === 'loading' && (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <div className="w-10 h-10 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-cinema-muted">Generating your share images...</p>
          </div>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div
              className="p-3 rounded-lg text-sm text-red-400 w-full"
              style={{
                backgroundColor: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.2)',
              }}
            >
              {error || 'Failed to generate share images. Please try again.'}
            </div>
            <button
              onClick={generate}
              className="px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
              style={{ border: '1px solid rgba(200,169,110,0.4)', color: '#c8a96e' }}
            >
              Try Again
            </button>
          </div>
        )}

        {/* Preview */}
        {phase === 'preview' && (
          <div className="flex flex-col gap-4">
            <div
              className="rounded-lg overflow-hidden border"
              style={{ borderColor: 'rgba(200,169,110,0.15)' }}
            >
              {activeImage ? (
                <Image
                  src={activeImage.url}
                  alt="Share image preview"
                  width={dims.w}
                  height={dims.h}
                  className="w-full h-auto"
                  unoptimized
                />
              ) : stillLoading ? (
                <div
                  className="flex items-center justify-center"
                  style={{ aspectRatio: `${dims.w}/${dims.h}` }}
                >
                  <div className="w-8 h-8 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <div
                  className="flex items-center justify-center text-sm text-cinema-muted py-12"
                  style={{ aspectRatio: `${dims.w}/${dims.h}` }}
                >
                  This style failed to generate
                </div>
              )}
            </div>

            {activeImage && (
              <>
                <div className="flex gap-3">
                  {canNativeShare && (
                    <button
                      onClick={handleShare}
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg font-semibold text-sm transition-colors"
                      style={{ backgroundColor: '#c8a96e', color: '#0f1117' }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                        <polyline points="16 6 12 2 8 6" />
                        <line x1="12" y1="2" x2="12" y2="15" />
                      </svg>
                      Share
                    </button>
                  )}
                  <button
                    onClick={handleSave}
                    className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg font-semibold text-sm transition-colors"
                    style={{ border: '1px solid rgba(200,169,110,0.4)', color: '#c8a96e' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Save Image
                  </button>
                </div>

                <p className="text-xs text-cinema-muted text-center">
                  On mobile, this will open your share sheet. On desktop, the image will download.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
