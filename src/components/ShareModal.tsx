'use client'

import { useState } from 'react'

interface Props {
  reviewId: string
  filmTitle: string
  onClose: () => void
}

export default function ShareModal({ reviewId, filmTitle, onClose }: Props) {
  const [sharing, setSharing] = useState<'full' | 'minimal' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const share = async (style: 'full' | 'minimal') => {
    setSharing(style)
    setError(null)
    try {
      const res = await fetch(`/api/share/review/${reviewId}?style=${style}`)
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error || 'Failed to generate share image. Please try again.')
        return
      }

      const blob = await res.blob()
      const file = new File([blob], 'my-review.png', { type: 'image/png' })

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: `My ${filmTitle} review on Cinemagraphs`,
        })
      } else {
        // Fallback: direct download
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'my-review.png'
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Share failed:', err)
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setSharing(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl max-w-lg w-full p-6"
        style={{
          backgroundColor: '#1a1a2e',
          border: '1px solid rgba(200,169,81,0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
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

        <p className="text-sm text-cinema-muted mb-4">
          Choose a style for your shareable image:
        </p>

        {error && (
          <div className="mb-4 p-3 rounded-lg text-sm text-red-400" style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          {/* Full Style Preview */}
          <button
            onClick={() => share('full')}
            disabled={sharing !== null}
            className="group rounded-lg overflow-hidden transition-all"
            style={{
              border: '1px solid rgba(200,169,81,0.2)',
              backgroundColor: 'rgba(255,255,255,0.03)',
            }}
          >
            <div className="aspect-[9/16] flex flex-col items-center justify-center p-4 relative">
              {/* Miniature preview of full style */}
              <div
                className="w-full h-1/2 rounded-t"
                style={{
                  background: 'linear-gradient(to bottom, rgba(200,169,81,0.15), #0D0D1A)',
                }}
              />
              <div className="flex-1 flex flex-col items-center justify-center gap-1">
                <span className="font-[family-name:var(--font-bebas)] text-2xl text-cinema-gold">
                  8.5
                </span>
                <div className="w-3/4 h-px bg-cinema-gold/20" />
                <span className="text-[8px] text-cinema-muted">Film Title</span>
                <div className="w-2/3 h-4 mt-1 rounded" style={{ backgroundColor: 'rgba(200,169,81,0.1)' }}>
                  <svg viewBox="0 0 100 16" className="w-full h-full">
                    <polyline
                      points="5,12 20,8 40,4 60,10 80,6 95,8"
                      fill="none"
                      stroke="#C8A951"
                      strokeWidth="1.5"
                    />
                  </svg>
                </div>
                <span className="text-[7px] text-cinema-muted italic mt-0.5">"Quote..."</span>
              </div>
              {sharing === 'full' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
            <div className="p-2 text-center border-t" style={{ borderColor: 'rgba(200,169,81,0.1)' }}>
              <span className="text-sm text-cinema-cream group-hover:text-cinema-gold transition-colors">
                Full
              </span>
            </div>
          </button>

          {/* Minimal Style Preview */}
          <button
            onClick={() => share('minimal')}
            disabled={sharing !== null}
            className="group rounded-lg overflow-hidden transition-all"
            style={{
              border: '1px solid rgba(200,169,81,0.2)',
              backgroundColor: 'rgba(255,255,255,0.03)',
            }}
          >
            <div className="aspect-[9/16] flex flex-col relative p-4">
              <div
                className="absolute inset-0 rounded-t"
                style={{
                  background: 'linear-gradient(to bottom, rgba(200,169,81,0.08), rgba(13,13,26,0.9) 60%)',
                }}
              />
              <div className="relative mt-auto">
                <div className="flex justify-end mb-2">
                  <span className="font-[family-name:var(--font-bebas)] text-xl text-cinema-gold">
                    8.5
                  </span>
                </div>
                <div className="w-full h-4 rounded" style={{ backgroundColor: 'rgba(200,169,81,0.1)' }}>
                  <svg viewBox="0 0 100 16" className="w-full h-full">
                    <polyline
                      points="5,12 20,8 40,4 60,10 80,6 95,8"
                      fill="none"
                      stroke="#C8A951"
                      strokeWidth="1.5"
                    />
                  </svg>
                </div>
                <span className="text-[7px] text-cinema-muted italic block mt-1">"Quote..."</span>
                <span className="text-[8px] text-cinema-cream block mt-0.5">Film Title</span>
              </div>
              {sharing === 'minimal' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
            <div className="p-2 text-center border-t" style={{ borderColor: 'rgba(200,169,81,0.1)' }}>
              <span className="text-sm text-cinema-cream group-hover:text-cinema-gold transition-colors">
                Minimal
              </span>
            </div>
          </button>
        </div>

        <p className="text-xs text-cinema-muted text-center mt-4">
          On mobile, this will open your share sheet. On desktop, the image will download.
        </p>
      </div>
    </div>
  )
}
