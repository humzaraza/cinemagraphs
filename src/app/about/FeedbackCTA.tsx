'use client'

export default function FeedbackCTA() {
  return (
    <button
      className="border border-cinema-gold/40 text-cinema-gold font-semibold px-7 py-3 rounded-lg hover:bg-cinema-gold/10 transition-colors text-sm"
      onClick={() => window.dispatchEvent(new Event('open-feedback'))}
    >
      Leave Feedback
    </button>
  )
}
