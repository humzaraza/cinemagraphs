'use client'

import { useState } from 'react'

interface Props {
  reviewId: string
  filmTitle: string
  onClose: () => void
}

type StyleOption = 'cinematic-card' | 'frosted-story'

export default function ShareModal({ reviewId, filmTitle, onClose }: Props) {
  const [sharing, setSharing] = useState<StyleOption | null>(null)
  const [error, setError] = useState<string | null>(null)

  const share = async (style: StyleOption) => {
    setSharing(style)
    setError(null)
    try {
      const res = await fetch(`/api/share/review/${reviewId}?style=${style}`)
      if (!res.ok) {
        const text = await res.text()
        console.error('[ShareModal] Error response:', res.status, text)
        let errorMsg = 'Failed to generate share image. Please try again.'
        try { const data = JSON.parse(text); if (data?.error) errorMsg = data.error } catch {}
        setError(errorMsg)
        return
      }

      const contentType = res.headers.get('content-type') || ''
      if (!contentType.includes('image')) {
        const text = await res.text()
        console.error('[ShareModal] Expected image, got:', contentType, text.slice(0, 200))
        setError('Server returned unexpected response. Please try again.')
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
          border: '1px solid rgba(200,169,110,0.2)',
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
          {/* Cinematic Card */}
          <button
            onClick={() => share('cinematic-card')}
            disabled={sharing !== null}
            className="group rounded-lg overflow-hidden transition-all"
            style={{
              border: '1px solid rgba(200,169,110,0.2)',
              backgroundColor: 'rgba(255,255,255,0.03)',
            }}
          >
            <div className="aspect-[9/16] flex flex-col relative" style={{ backgroundColor: '#0f1117' }}>
              {/* Poster strip top */}
              <div
                className="w-full"
                style={{
                  height: '25%',
                  background: 'linear-gradient(to bottom, rgba(200,169,110,0.2), #0f1117)',
                }}
              />
              {/* Title + score row */}
              <div className="flex justify-between items-start px-3 mt-1">
                <div>
                  <div className="text-[8px] font-bold" style={{ color: '#f5f0e8' }}>Film Title</div>
                  <div className="text-[6px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>2024 &middot; Director</div>
                </div>
                <span className="font-[family-name:var(--font-playfair)] text-lg font-bold" style={{ color: '#c8a96e' }}>
                  8.5
                </span>
              </div>
              {/* SENTIMENT ARC label */}
              <div className="px-3 mt-1.5">
                <div className="text-[5px] font-bold tracking-widest" style={{ color: '#c8a96e' }}>SENTIMENT ARC</div>
              </div>
              {/* Graph panel */}
              <div className="mx-2 mt-1 rounded flex-1 flex items-center justify-center" style={{ backgroundColor: '#181b24', border: '1px solid rgba(200,169,110,0.1)' }}>
                <svg viewBox="0 0 100 40" className="w-4/5 h-3/5">
                  <line x1="5" y1="20" x2="95" y2="20" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" strokeDasharray="3 2" />
                  <path d="M5,32 L20,25 L40,15 L55,22 L70,10 L85,18 L95,14" fill="none" stroke="#c8a96e" strokeWidth="1.5" />
                </svg>
              </div>
              {/* Quote */}
              <div className="px-3 mt-1.5">
                <div className="text-[6px] italic" style={{ color: 'rgba(255,255,255,0.5)' }}>&ldquo;Great film...&rdquo;</div>
                <div className="text-[5px] text-right mt-0.5" style={{ color: '#c8a96e' }}>&mdash; User</div>
              </div>
              {/* Footer */}
              <div className="flex justify-between items-center px-3 pb-1.5 mt-auto">
                <span className="text-[6px] font-bold" style={{ color: '#c8a96e' }}>Cinemagraphs</span>
                <span className="text-[5px]" style={{ color: 'rgba(255,255,255,0.3)' }}>cinemagraphs.ca</span>
              </div>
              <div className="w-full h-0.5" style={{ backgroundColor: '#c8a96e' }} />
              {sharing === 'cinematic-card' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
            <div className="p-2 text-center border-t" style={{ borderColor: 'rgba(200,169,110,0.1)' }}>
              <span className="text-sm text-cinema-cream group-hover:text-cinema-gold transition-colors">
                Cinematic Card
              </span>
            </div>
          </button>

          {/* Frosted Story */}
          <button
            onClick={() => share('frosted-story')}
            disabled={sharing !== null}
            className="group rounded-lg overflow-hidden transition-all"
            style={{
              border: '1px solid rgba(200,169,110,0.2)',
              backgroundColor: 'rgba(255,255,255,0.03)',
            }}
          >
            <div className="aspect-[9/16] flex flex-col relative" style={{ backgroundColor: '#0f1117' }}>
              {/* Full-bleed poster with gradient */}
              <div
                className="absolute inset-0"
                style={{
                  background: 'linear-gradient(to bottom, rgba(200,169,110,0.12), rgba(15,17,23,0.85) 45%, rgba(15,17,23,0.98) 65%)',
                }}
              />
              {/* Top bar */}
              <div className="relative flex justify-between items-start px-3 pt-2">
                <span className="text-[5px] font-bold tracking-widest" style={{ color: '#c8a96e' }}>CINEMAGRAPHS</span>
                <span className="font-[family-name:var(--font-playfair)] text-xl font-bold" style={{ color: '#c8a96e' }}>8.5</span>
              </div>
              {/* Title area */}
              <div className="relative px-3 mt-auto mb-0">
                <div className="text-[10px] font-bold leading-tight" style={{ color: '#f5f0e8' }}>Film Title</div>
                <div className="text-[6px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>2024 &middot; Director</div>
              </div>
              {/* Graph */}
              <div className="relative mx-2 mt-1.5 rounded flex items-center justify-center" style={{ backgroundColor: 'rgba(24,27,36,0.85)', border: '1px solid rgba(200,169,110,0.12)', height: '22%' }}>
                <svg viewBox="0 0 100 40" className="w-4/5 h-3/5">
                  <line x1="5" y1="20" x2="95" y2="20" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" strokeDasharray="3 2" />
                  <path d="M5,32 L20,25 L40,15 L55,22 L70,10 L85,18 L95,14" fill="none" stroke="#c8a96e" strokeWidth="1.5" />
                </svg>
              </div>
              {/* Quote card with gold border */}
              <div className="relative flex mx-3 mt-1.5 mb-2">
                <div className="w-0.5 rounded-full mr-1.5 flex-shrink-0" style={{ backgroundColor: '#c8a96e' }} />
                <div>
                  <div className="text-[6px] italic" style={{ color: 'rgba(255,255,255,0.5)' }}>&ldquo;Great film...&rdquo;</div>
                  <div className="text-[5px] mt-0.5" style={{ color: '#c8a96e' }}>&mdash; User</div>
                </div>
              </div>
              {/* Bottom branding */}
              <div className="relative text-center pb-1.5">
                <span className="text-[5px]" style={{ color: 'rgba(255,255,255,0.3)' }}>cinemagraphs.ca</span>
              </div>
              <div className="w-full h-0.5" style={{ backgroundColor: '#c8a96e' }} />
              {sharing === 'frosted-story' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
            <div className="p-2 text-center border-t" style={{ borderColor: 'rgba(200,169,110,0.1)' }}>
              <span className="text-sm text-cinema-cream group-hover:text-cinema-gold transition-colors">
                Frosted Story
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
