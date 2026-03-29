'use client'

import { useState } from 'react'

interface Props {
  reviewId: string
  filmTitle: string
  onClose: () => void
}

type StyleOption = 'cinematic-overlay' | 'graph-hero'

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
          {/* Cinematic Overlay */}
          <button
            onClick={() => share('cinematic-overlay')}
            disabled={sharing !== null}
            className="group rounded-lg overflow-hidden transition-all"
            style={{
              border: '1px solid rgba(200,169,110,0.2)',
              backgroundColor: 'rgba(255,255,255,0.03)',
            }}
          >
            <div className="aspect-[9/16] flex flex-col relative" style={{ backgroundColor: '#0f1117' }}>
              {/* Poster gradient background */}
              <div
                className="absolute inset-0"
                style={{
                  background: 'linear-gradient(to bottom, rgba(200,169,110,0.15) 0%, rgba(15,17,23,0.5) 35%, rgba(15,17,23,0.9) 55%, rgba(15,17,23,0.98) 70%)',
                }}
              />
              {/* Top bar: branding + score */}
              <div className="relative flex justify-between items-start px-3 pt-2">
                <span className="text-[5px] font-bold tracking-widest" style={{ color: '#c8a96e' }}>CINEMAGRAPHS</span>
                <span className="font-[family-name:var(--font-playfair)] text-sm font-bold" style={{ color: '#c8a96e' }}>8.5</span>
              </div>
              {/* Poster visible area (middle) */}
              <div className="flex-1" />
              {/* Title + meta in lower-middle */}
              <div className="relative px-3">
                <div className="text-[7px] font-bold leading-tight" style={{ color: '#f5f0e8' }}>Film Title</div>
                <div className="text-[5px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>2024 &middot; Director</div>
              </div>
              {/* SENTIMENT ARC label */}
              <div className="relative px-3 mt-1">
                <div className="text-[4px] font-bold tracking-widest" style={{ color: '#c8a96e' }}>SENTIMENT ARC</div>
              </div>
              {/* Graph in semi-transparent panel with gold glow */}
              <div
                className="relative mx-2 mt-0.5 rounded flex items-center justify-center"
                style={{
                  backgroundColor: 'rgba(15,17,23,0.75)',
                  border: '1px solid rgba(200,169,110,0.2)',
                  boxShadow: '0 0 8px rgba(200,169,110,0.1)',
                  height: '20%',
                }}
              >
                <svg viewBox="0 0 100 40" className="w-4/5 h-3/5">
                  <line x1="5" y1="20" x2="95" y2="20" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" strokeDasharray="3 2" />
                  <path d="M5,32 L20,25 L40,15 L55,22 L70,10 L85,18 L95,14" fill="rgba(200,169,110,0.08)" stroke="#c8a96e" strokeWidth="1.5" />
                </svg>
              </div>
              {/* Quote */}
              <div className="relative flex mx-3 mt-1">
                <div className="w-0.5 rounded-full mr-1.5 flex-shrink-0" style={{ backgroundColor: '#c8a96e' }} />
                <div>
                  <div className="text-[5px] italic" style={{ color: 'rgba(255,255,255,0.5)' }}>&ldquo;Great film...&rdquo;</div>
                  <div className="text-[4px] mt-0.5 text-right" style={{ color: '#c8a96e' }}>&mdash; User</div>
                </div>
              </div>
              {/* Footer */}
              <div className="relative text-center py-1">
                <span className="text-[5px]" style={{ color: 'rgba(255,255,255,0.3)' }}>cinemagraphs.ca</span>
              </div>
              <div className="w-full h-0.5" style={{ backgroundColor: '#c8a96e' }} />
              {sharing === 'cinematic-overlay' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
            <div className="p-2 text-center border-t" style={{ borderColor: 'rgba(200,169,110,0.1)' }}>
              <span className="text-sm text-cinema-cream group-hover:text-cinema-gold transition-colors">
                Cinematic Overlay
              </span>
            </div>
          </button>

          {/* Graph Hero */}
          <button
            onClick={() => share('graph-hero')}
            disabled={sharing !== null}
            className="group rounded-lg overflow-hidden transition-all"
            style={{
              border: '1px solid rgba(200,169,110,0.2)',
              backgroundColor: 'rgba(255,255,255,0.03)',
            }}
          >
            <div className="aspect-[9/16] flex flex-col relative" style={{ backgroundColor: '#0f1117' }}>
              {/* Lighter gradient — poster more visible */}
              <div
                className="absolute inset-0"
                style={{
                  background: 'linear-gradient(to bottom, rgba(200,169,110,0.08) 0%, rgba(15,17,23,0.3) 30%, rgba(15,17,23,0.7) 50%, rgba(15,17,23,0.95) 70%)',
                }}
              />
              {/* Top branding centered */}
              <div className="relative text-center pt-2">
                <span className="text-[5px] font-bold tracking-widest" style={{ color: '#c8a96e' }}>CINEMAGRAPHS</span>
              </div>
              {/* Poster visible area (larger) */}
              <div className="flex-1" />
              {/* Title + score on same row */}
              <div className="relative flex justify-between items-baseline px-3">
                <div>
                  <div className="text-[8px] font-bold leading-tight" style={{ color: '#f5f0e8' }}>Film Title</div>
                  <div className="text-[5px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>2024 &middot; Director</div>
                </div>
                <span className="font-[family-name:var(--font-playfair)] text-[8px] font-bold" style={{ color: '#c8a96e' }}>8.5</span>
              </div>
              {/* SENTIMENT ARC label */}
              <div className="relative px-3 mt-1">
                <div className="text-[4px] font-bold tracking-widest" style={{ color: '#c8a96e' }}>SENTIMENT ARC</div>
              </div>
              {/* Borderless graph — no container, floating */}
              <div className="relative mx-2 mt-0.5 flex items-center justify-center" style={{ height: '24%' }}>
                <svg viewBox="0 0 100 50" className="w-4/5 h-4/5">
                  {/* Faint grid lines */}
                  <line x1="5" y1="10" x2="95" y2="10" stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                  <line x1="5" y1="20" x2="95" y2="20" stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                  <line x1="5" y1="30" x2="95" y2="30" stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                  <line x1="5" y1="40" x2="95" y2="40" stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
                  {/* Area fill + line */}
                  <path d="M5,42 L20,33 L40,18 L55,28 L70,12 L85,22 L95,17 L95,50 L5,50 Z" fill="rgba(200,169,110,0.12)" />
                  <path d="M5,42 L20,33 L40,18 L55,28 L70,12 L85,22 L95,17" fill="none" stroke="#c8a96e" strokeWidth="1.8" />
                  {/* Dots with glow */}
                  <circle cx="5" cy="42" r="2.5" fill="rgba(200,169,110,0.3)" />
                  <circle cx="5" cy="42" r="1.5" fill="#c8a96e" />
                  <circle cx="40" cy="18" r="2.5" fill="rgba(200,169,110,0.3)" />
                  <circle cx="40" cy="18" r="1.5" fill="#c8a96e" />
                  <circle cx="70" cy="12" r="2.5" fill="rgba(200,169,110,0.3)" />
                  <circle cx="70" cy="12" r="1.5" fill="#c8a96e" />
                  <circle cx="95" cy="17" r="2.5" fill="rgba(200,169,110,0.3)" />
                  <circle cx="95" cy="17" r="1.5" fill="#c8a96e" />
                </svg>
              </div>
              {/* Compact quote */}
              <div className="relative flex mx-3 mt-0.5 mb-1">
                <div className="w-0.5 rounded-full mr-1.5 flex-shrink-0" style={{ backgroundColor: '#c8a96e' }} />
                <div>
                  <div className="text-[5px] italic" style={{ color: 'rgba(255,255,255,0.45)' }}>&ldquo;Great film...&rdquo;</div>
                  <div className="text-[4px] mt-0.5 text-right" style={{ color: '#c8a96e' }}>&mdash; User</div>
                </div>
              </div>
              {/* Footer */}
              <div className="relative text-center py-1">
                <span className="text-[5px]" style={{ color: 'rgba(255,255,255,0.3)' }}>cinemagraphs.ca</span>
              </div>
              <div className="w-full h-0.5" style={{ backgroundColor: '#c8a96e' }} />
              {sharing === 'graph-hero' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
                </div>
              )}
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
      </div>
    </div>
  )
}
