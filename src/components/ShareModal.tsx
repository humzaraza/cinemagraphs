'use client'

import { useState, useCallback } from 'react'
import Image from 'next/image'

interface Props {
  reviewId: string
  filmTitle: string
  onClose: () => void
}

type StyleOption = 'cinematic-overlay' | 'graph-hero'
type Phase = 'pick' | 'loading' | 'preview'

export default function ShareModal({ reviewId, filmTitle, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('pick')
  const [selectedStyle, setSelectedStyle] = useState<StyleOption | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imageBlob, setImageBlob] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)

  const generate = useCallback(async (style: StyleOption) => {
    setSelectedStyle(style)
    setPhase('loading')
    setError(null)
    try {
      const res = await fetch(`/api/share/review/${reviewId}?style=${style}`)
      if (!res.ok) {
        const text = await res.text()
        console.error('[ShareModal] Error response:', res.status, text)
        let errorMsg = 'Failed to generate share image. Please try again.'
        try { const data = JSON.parse(text); if (data?.error) errorMsg = data.error } catch {}
        setError(errorMsg)
        setPhase('pick')
        return
      }

      const contentType = res.headers.get('content-type') || ''
      if (!contentType.includes('image')) {
        const text = await res.text()
        console.error('[ShareModal] Expected image, got:', contentType, text.slice(0, 200))
        setError('Server returned unexpected response. Please try again.')
        setPhase('pick')
        return
      }

      const blob = await res.blob()
      setImageBlob(blob)
      setPreviewUrl(URL.createObjectURL(blob))
      setPhase('preview')
    } catch (err) {
      console.error('Share generation failed:', err)
      setError('Something went wrong. Please try again.')
      setPhase('pick')
    }
  }, [reviewId])

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

  const handleBack = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setImageBlob(null)
    setPhase('pick')
    setSelectedStyle(null)
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
          <div className="flex items-center gap-3">
            {phase === 'preview' && (
              <button
                onClick={handleBack}
                className="text-cinema-muted hover:text-cinema-cream transition-colors"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            )}
            <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold text-cinema-cream">
              {phase === 'preview' ? 'Preview' : 'Share Your Review'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-cinema-muted hover:text-cinema-cream transition-colors text-lg"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg text-sm text-red-400" style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
            {error}
          </div>
        )}

        {/* Phase: Pick Style */}
        {phase === 'pick' && (
          <>
            <p className="text-sm text-cinema-muted mb-4">
              Choose a style for your shareable image:
            </p>
            <div className="grid grid-cols-2 gap-4">
              {/* Cinematic Overlay */}
              <button
                onClick={() => generate('cinematic-overlay')}
                className="group rounded-lg overflow-hidden transition-all"
                style={{
                  border: '1px solid rgba(200,169,110,0.2)',
                  backgroundColor: 'rgba(255,255,255,0.03)',
                }}
              >
                <div className="aspect-[9/16] flex flex-col relative" style={{ backgroundColor: '#0f1117' }}>
                  <div
                    className="absolute inset-0"
                    style={{
                      background: 'linear-gradient(to bottom, rgba(200,169,110,0.15) 0%, rgba(15,17,23,0.5) 35%, rgba(15,17,23,0.9) 55%, rgba(15,17,23,0.98) 70%)',
                    }}
                  />
                  <div className="relative flex justify-between items-start px-3 pt-2">
                    <span className="text-[5px] font-bold tracking-widest" style={{ color: '#c8a96e' }}>CINEMAGRAPHS</span>
                    <span className="font-[family-name:var(--font-playfair)] text-base font-bold" style={{ color: '#c8a96e' }}>8.5</span>
                  </div>
                  <div className="flex-1" />
                  <div className="relative px-3">
                    <div className="text-[7px] font-bold leading-tight" style={{ color: '#f5f0e8' }}>Film Title</div>
                    <div className="text-[5px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>2024 &middot; Director</div>
                  </div>
                  <div className="relative px-3 mt-1">
                    <div className="text-[4px] font-bold tracking-widest" style={{ color: '#c8a96e' }}>SENTIMENT ARC</div>
                  </div>
                  <div
                    className="relative mx-2 mt-0.5 rounded flex items-center justify-center"
                    style={{
                      backgroundColor: 'rgba(15,17,23,0.65)',
                      border: '1px solid rgba(200,169,110,0.2)',
                      height: '18%',
                    }}
                  >
                    <svg viewBox="0 0 100 40" className="w-4/5 h-3/5">
                      <line x1="5" y1="20" x2="95" y2="20" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" strokeDasharray="3 2" />
                      <path d="M5,32 L20,25 L40,15 L55,22 L70,10 L85,18 L95,14" fill="rgba(200,169,110,0.05)" stroke="#c8a96e" strokeWidth="1.5" />
                    </svg>
                  </div>
                  <div className="relative flex mx-3 mt-1">
                    <div className="w-0.5 rounded-full mr-1.5 flex-shrink-0" style={{ backgroundColor: '#c8a96e' }} />
                    <div>
                      <div className="text-[5px] italic" style={{ color: 'rgba(255,255,255,0.5)' }}>&ldquo;Great film...&rdquo;</div>
                      <div className="text-[4px] mt-0 text-right" style={{ color: '#c8a96e' }}>&mdash; User</div>
                    </div>
                  </div>
                  <div className="relative text-center py-1">
                    <span className="text-[5px]" style={{ color: 'rgba(255,255,255,0.3)' }}>cinemagraphs.ca</span>
                  </div>
                  <div className="w-full h-0.5" style={{ backgroundColor: '#c8a96e' }} />
                </div>
                <div className="p-2 text-center border-t" style={{ borderColor: 'rgba(200,169,110,0.1)' }}>
                  <span className="text-sm text-cinema-cream group-hover:text-cinema-gold transition-colors">
                    Cinematic Overlay
                  </span>
                </div>
              </button>

              {/* Graph Hero */}
              <button
                onClick={() => generate('graph-hero')}
                className="group rounded-lg overflow-hidden transition-all"
                style={{
                  border: '1px solid rgba(200,169,110,0.2)',
                  backgroundColor: 'rgba(255,255,255,0.03)',
                }}
              >
                <div className="aspect-[9/16] flex flex-col relative" style={{ backgroundColor: '#0f1117' }}>
                  <div
                    className="absolute inset-0"
                    style={{
                      background: 'linear-gradient(to bottom, rgba(200,169,110,0.08) 0%, rgba(15,17,23,0.3) 30%, rgba(15,17,23,0.7) 50%, rgba(15,17,23,0.95) 70%)',
                    }}
                  />
                  <div className="relative text-center pt-2">
                    <span className="text-[5px] font-bold tracking-widest" style={{ color: '#c8a96e' }}>CINEMAGRAPHS</span>
                  </div>
                  <div className="flex-1" />
                  <div className="relative flex justify-between items-baseline px-3">
                    <div>
                      <div className="text-[8px] font-bold leading-tight" style={{ color: '#f5f0e8' }}>Film Title</div>
                      <div className="text-[5px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>2024 &middot; Director</div>
                    </div>
                    <span className="font-[family-name:var(--font-playfair)] text-base font-bold" style={{ color: '#c8a96e' }}>8.5</span>
                  </div>
                  <div className="relative px-3 mt-1">
                    <div className="text-[4px] font-bold tracking-widest" style={{ color: '#c8a96e' }}>SENTIMENT ARC</div>
                  </div>
                  <div className="relative mx-2 mt-0.5 flex items-center justify-center" style={{ height: '22%' }}>
                    <svg viewBox="0 0 100 50" className="w-4/5 h-4/5">
                      <line x1="5" y1="10" x2="95" y2="10" stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                      <line x1="5" y1="20" x2="95" y2="20" stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                      <line x1="5" y1="30" x2="95" y2="30" stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                      <line x1="5" y1="40" x2="95" y2="40" stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                      <path d="M5,42 L20,33 L40,18 L55,28 L70,12 L85,22 L95,17 L95,50 L5,50 Z" fill="rgba(200,169,110,0.05)" />
                      <path d="M5,42 L20,33 L40,18 L55,28 L70,12 L85,22 L95,17" fill="none" stroke="#c8a96e" strokeWidth="1.8" />
                    </svg>
                  </div>
                  <div className="relative flex mx-3 mt-0.5 mb-1">
                    <div className="w-0.5 rounded-full mr-1.5 flex-shrink-0" style={{ backgroundColor: '#c8a96e' }} />
                    <div>
                      <div className="text-[5px] italic" style={{ color: 'rgba(255,255,255,0.45)' }}>&ldquo;Great film...&rdquo;</div>
                      <div className="text-[4px] mt-0 text-right" style={{ color: '#c8a96e' }}>&mdash; User</div>
                    </div>
                  </div>
                  <div className="relative text-center py-1">
                    <span className="text-[5px]" style={{ color: 'rgba(255,255,255,0.3)' }}>cinemagraphs.ca</span>
                  </div>
                  <div className="w-full h-0.5" style={{ backgroundColor: '#c8a96e' }} />
                </div>
                <div className="p-2 text-center border-t" style={{ borderColor: 'rgba(200,169,110,0.1)' }}>
                  <span className="text-sm text-cinema-cream group-hover:text-cinema-gold transition-colors">
                    Graph Hero
                  </span>
                </div>
              </button>
            </div>
            <p className="text-xs text-cinema-muted text-center mt-4">
              On mobile, this will open your share sheet. On desktop, the image will download.
            </p>
          </>
        )}

        {/* Phase: Loading */}
        {phase === 'loading' && (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <div className="w-10 h-10 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-cinema-muted">
              Generating your {selectedStyle === 'cinematic-overlay' ? 'Cinematic Overlay' : 'Graph Hero'} image...
            </p>
          </div>
        )}

        {/* Phase: Preview */}
        {phase === 'preview' && previewUrl && (
          <div className="flex flex-col gap-4">
            {/* Image preview */}
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

            {/* Action buttons */}
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
          </div>
        )}
      </div>
    </div>
  )
}
