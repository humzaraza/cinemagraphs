'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'

interface Props {
  reviewId: string
  filmTitle: string
  onClose: () => void
}

type Phase = 'loading' | 'preview' | 'error'

export default function ShareModal({ reviewId, filmTitle, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imageBlob, setImageBlob] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)

  const generate = useCallback(async () => {
    setPhase('loading')
    setError(null)
    try {
      const res = await fetch(`/api/share/review/${reviewId}?style=graph-hero`)
      if (!res.ok) {
        const text = await res.text()
        console.error('[ShareModal] Error response:', res.status, text)
        let errorMsg = 'Failed to generate share image. Please try again.'
        try { const data = JSON.parse(text); if (data?.error) errorMsg = data.error } catch {}
        setError(errorMsg)
        setPhase('error')
        return
      }

      const contentType = res.headers.get('content-type') || ''
      if (!contentType.includes('image')) {
        const text = await res.text()
        console.error('[ShareModal] Expected image, got:', contentType, text.slice(0, 200))
        setError('Server returned unexpected response. Please try again.')
        setPhase('error')
        return
      }

      const blob = await res.blob()
      setImageBlob(blob)
      setPreviewUrl(URL.createObjectURL(blob))
      setPhase('preview')
    } catch (err) {
      console.error('Share generation failed:', err)
      setError('Something went wrong. Please try again.')
      setPhase('error')
    }
  }, [reviewId])

  useEffect(() => {
    generate()
    return () => {
      // Cleanup blob URL on unmount
    }
  }, [generate])

  const handleShare = async () => {
    if (!imageBlob) return
    const file = new File([imageBlob], 'my-review.png', { type: 'image/png' })
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
    if (!previewUrl) return
    const a = document.createElement('a')
    a.href = previewUrl
    a.download = `${filmTitle.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-review.png`
    a.click()
  }

  const canNativeShare = typeof navigator !== 'undefined' && !!navigator.share

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto"
        style={{
          backgroundColor: '#1a1a2e',
          border: '1px solid rgba(200,169,110,0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold text-cinema-cream">
            {phase === 'preview' ? 'Preview' : 'Share Your Review'}
          </h2>
          <button
            onClick={onClose}
            className="text-cinema-muted hover:text-cinema-cream transition-colors text-lg"
          >
            ✕
          </button>
        </div>

        {/* Loading */}
        {phase === 'loading' && (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <div className="w-10 h-10 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-cinema-muted">Generating your share image...</p>
          </div>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="p-3 rounded-lg text-sm text-red-400 w-full" style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
              {error}
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
        {phase === 'preview' && previewUrl && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'rgba(200,169,110,0.15)' }}>
              <Image
                src={previewUrl}
                alt="Share image preview"
                width={1080}
                height={1920}
                className="w-full h-auto"
                unoptimized
              />
            </div>

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
          </div>
        )}
      </div>
    </div>
  )
}
