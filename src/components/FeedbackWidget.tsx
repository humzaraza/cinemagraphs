'use client'

import { useState, useEffect } from 'react'

const TYPES = [
  { value: 'bug', label: 'Bug' },
  { value: 'suggestion', label: 'Suggestion' },
  { value: 'support', label: 'Support' },
  { value: 'other', label: 'Other' },
] as const

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<string>('suggestion')
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener('open-feedback', handler)
    return () => window.removeEventListener('open-feedback', handler)
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (message.trim().length < 5) return

    setStatus('sending')
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          message,
          page: window.location.pathname,
        }),
      })
      if (!res.ok) throw new Error()
      setStatus('sent')
      setTimeout(() => {
        setOpen(false)
        setStatus('idle')
        setMessage('')
        setType('suggestion')
      }, 2000)
    } catch {
      setStatus('error')
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-cinema-gold text-cinema-dark shadow-lg hover:scale-110 transition-transform flex items-center justify-center"
        aria-label="Send feedback"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {/* Modal backdrop + dialog */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-md bg-cinema-darker border border-cinema-border rounded-xl shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-cinema-border">
              <h2 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream">
                Send Feedback
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="text-cinema-muted hover:text-cinema-cream transition-colors"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              {/* Type selector */}
              <div className="flex gap-2">
                {TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setType(t.value)}
                    className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                      type === t.value
                        ? 'bg-cinema-gold text-cinema-dark border-cinema-gold font-semibold'
                        : 'border-cinema-border text-cinema-muted hover:border-cinema-gold/50 hover:text-cinema-cream'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Support note */}
              {type === 'support' && (
                <p className="text-sm text-cinema-muted">
                  You can also email us at{' '}
                  <a href="mailto:cinemagraphs.corp@gmail.com" className="text-cinema-gold hover:underline">
                    cinemagraphs.corp@gmail.com
                  </a>
                  {' '}or reach out on X at{' '}
                  <a
                    href="https://x.com/cinemagraphsco"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cinema-gold hover:underline"
                  >
                    @cinemagraphsco
                  </a>
                </p>
              )}

              {/* Message */}
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Tell us what's on your mind..."
                rows={4}
                maxLength={5000}
                className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2.5 text-sm text-cinema-cream placeholder:text-cinema-muted/50 focus:outline-none focus:border-cinema-gold/50 resize-none"
              />

              {/* Submit */}
              <button
                type="submit"
                disabled={status === 'sending' || status === 'sent' || message.trim().length < 5}
                className="w-full py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-cinema-gold text-cinema-dark hover:bg-cinema-gold/90"
              >
                {status === 'sending' ? 'Sending...' : status === 'sent' ? 'Thanks!' : status === 'error' ? 'Failed — try again' : 'Submit'}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
