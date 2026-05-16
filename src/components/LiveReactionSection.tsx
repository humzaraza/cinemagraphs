'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useSession, signIn } from 'next-auth/react'

const REACTIONS = [
  { key: 'up', emoji: '👍', label: 'Like', weight: '+0.5', color: 'var(--cinema-teal)' },
  { key: 'down', emoji: '👎', label: 'Dislike', weight: '-0.5', color: '#ef4444' },
  { key: 'wow', emoji: '🤩', label: 'Wow', weight: '+1.0', color: 'var(--cinema-gold)' },
  { key: 'shock', emoji: '😱', label: 'Shock', weight: '+0.5', color: '#a855f7' },
  { key: 'funny', emoji: '😂', label: 'Funny', weight: '+0.3', color: '#38bdf8' },
]

interface ReactionPoint {
  time: number
  score: number
  emoji: string
}

interface IncompleteSession {
  id: string
  lastReactionAt: string
  completionRate: number
  reactions: { reaction: string; score: number; sessionTimestamp: number }[]
}

interface Props {
  filmId: string
  runtime: number | null
}

export default function LiveReactionSection({ filmId, runtime }: Props) {
  const { data: session } = useSession()
  const [isPlaying, setIsPlaying] = useState(false)
  const [elapsed, setElapsed] = useState(0) // seconds
  const [currentScore, setCurrentScore] = useState(5)
  const [points, setPoints] = useState<ReactionPoint[]>([])
  const [lastReaction, setLastReaction] = useState<{ emoji: string; score: number } | null>(null)
  const [cooldown, setCooldown] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [incompleteSession, setIncompleteSession] = useState<IncompleteSession | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const totalSeconds = (runtime || 120) * 60

  // Check for incomplete session on mount
  useEffect(() => {
    if (!session?.user?.id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO(lint): sync-external-state pattern; revisit when migrating to derived state
      setCheckingSession(false)
      return
    }

    fetch(`/api/films/${filmId}/reaction-sessions`)
      .then((r) => r.json())
      .then((data) => {
        if (data.session && data.session.completionRate < 1.0) {
          setIncompleteSession(data.session)
        }
      })
      .catch(() => {})
      .finally(() => setCheckingSession(false))
  }, [filmId, session?.user?.id])

  async function startNewSession(abandonPrevious = false) {
    try {
      const res = await fetch(`/api/films/${filmId}/reaction-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ abandonPrevious }),
      })
      const data = await res.json()
      setSessionId(data.session.id)
      setIncompleteSession(null)
    } catch {
      setError('Failed to start session')
    }
  }

  function resumeSession() {
    if (!incompleteSession) return

    setSessionId(incompleteSession.id)

    // Restore previous reactions onto the graph
    const emojiMap: Record<string, string> = {
      up: '👍', down: '👎', wow: '🤩', shock: '😱', funny: '😂',
    }

    const restoredPoints: ReactionPoint[] = incompleteSession.reactions.map((r) => ({
      time: r.sessionTimestamp,
      score: r.score,
      emoji: emojiMap[r.reaction] || '',
    }))

    setPoints(restoredPoints)

    // Set elapsed to last reaction timestamp
    const lastTs = incompleteSession.reactions.length > 0
      ? incompleteSession.reactions[incompleteSession.reactions.length - 1].sessionTimestamp
      : 0
    setElapsed(lastTs)

    // Set current score to last reaction score
    const lastScore = incompleteSession.reactions.length > 0
      ? incompleteSession.reactions[incompleteSession.reactions.length - 1].score
      : 5
    setCurrentScore(lastScore)

    setIncompleteSession(null)
  }

  // Timer logic
  useEffect(() => {
    if (isPlaying) {
      timerRef.current = setInterval(() => {
        setElapsed((prev) => {
          if (prev >= totalSeconds) {
            setIsPlaying(false)
            return prev
          }
          return prev + 1
        })
      }, 1000)
    } else if (timerRef.current) {
      clearInterval(timerRef.current)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [isPlaying, totalSeconds])

  // Draw canvas graph
  const drawGraph = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)
    const w = rect.width
    const h = rect.height

    // Clear
    ctx.fillStyle = '#0f0f1a'
    ctx.fillRect(0, 0, w, h)

    // Grid lines
    ctx.strokeStyle = 'var(--cinema-border)'
    ctx.lineWidth = 0.5
    for (let i = 1; i <= 9; i++) {
      const y = h - (i / 10) * h
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }

    // Neutral line at 5
    ctx.strokeStyle = '#666'
    ctx.setLineDash([4, 4])
    const neutralY = h - (5 / 10) * h
    ctx.beginPath()
    ctx.moveTo(0, neutralY)
    ctx.lineTo(w, neutralY)
    ctx.stroke()
    ctx.setLineDash([])

    if (points.length === 0) {
      // Just show the neutral start
      ctx.fillStyle = 'var(--cinema-gold)'
      ctx.beginPath()
      ctx.arc(0, neutralY, 4, 0, Math.PI * 2)
      ctx.fill()
      return
    }

    // Draw sentiment line
    const allPoints = [{ time: 0, score: 5, emoji: '' }, ...points]
    const maxTime = Math.max(elapsed, allPoints[allPoints.length - 1].time)

    ctx.beginPath()
    ctx.strokeStyle = 'var(--cinema-gold)'
    ctx.lineWidth = 2

    for (let i = 0; i < allPoints.length; i++) {
      const x = maxTime > 0 ? (allPoints[i].time / maxTime) * w : 0
      const y = h - (allPoints[i].score / 10) * h
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Gradient fill
    const lastPoint = allPoints[allPoints.length - 1]
    const lastX = maxTime > 0 ? (lastPoint.time / maxTime) * w : 0
    const lastY = h - (lastPoint.score / 10) * h

    ctx.lineTo(lastX, h)
    ctx.lineTo(0, h)
    ctx.closePath()

    const gradient = ctx.createLinearGradient(0, 0, 0, h)
    gradient.addColorStop(0, 'rgba(200, 169, 81, 0.3)')
    gradient.addColorStop(1, 'rgba(200, 169, 81, 0)')
    ctx.fillStyle = gradient
    ctx.fill()

    // Current score dot
    ctx.fillStyle = 'var(--cinema-gold)'
    ctx.beginPath()
    ctx.arc(lastX, lastY, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'var(--cinema-cream)'
    ctx.lineWidth = 2
    ctx.stroke()
  }, [points, elapsed])

  useEffect(() => {
    drawGraph()
  }, [drawGraph])

  // Resize handler
  useEffect(() => {
    const handler = () => drawGraph()
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [drawGraph])

  function formatTimer(secs: number): string {
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const s = secs % 60
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }

  async function handleReaction(reactionKey: string) {
    if (!session) {
      signIn()
      return
    }

    // Auto-create session if not started
    if (!sessionId) {
      await startNewSession()
    }

    if (cooldown) return

    setError(null)
    setCooldown(true)

    try {
      const res = await fetch(`/api/films/${filmId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reaction: reactionKey,
          sessionTimestamp: elapsed,
          currentScore,
          sessionId,
        }),
      })

      if (res.status === 429) {
        const data = await res.json()
        setError(data.error)
        setTimeout(() => setCooldown(false), 10000)
        return
      }

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to submit reaction')
        setCooldown(false)
        return
      }

      const data = await res.json()
      const emoji = REACTIONS.find((r) => r.key === reactionKey)?.emoji || ''
      setCurrentScore(data.score)
      setLastReaction({ emoji, score: data.score })
      setPoints((prev) => [...prev, { time: elapsed, score: data.score, emoji }])
    } catch {
      setError('Network error')
    }

    // 10 second cooldown
    setTimeout(() => setCooldown(false), 10000)
  }

  function handleReset() {
    if (!confirm('Reset your reaction session? This will clear your live graph.')) return
    setElapsed(0)
    setCurrentScore(5)
    setPoints([])
    setLastReaction(null)
    setIsPlaying(false)
    startNewSession(true)
  }

  const progress = totalSeconds > 0 ? (elapsed / totalSeconds) * 100 : 0

  // Show resume banner
  if (!checkingSession && incompleteSession) {
    const lastTs = incompleteSession.reactions.length > 0
      ? incompleteSession.reactions[incompleteSession.reactions.length - 1].sessionTimestamp
      : 0
    const mins = Math.floor(lastTs / 60)
    const secs = lastTs % 60

    return (
      <div className="space-y-4">
        <div
          className="rounded-lg p-4"
          style={{
            background: 'linear-gradient(135deg, rgba(200,169,81,0.15), rgba(200,169,81,0.05))',
            border: '1px solid rgba(200,169,81,0.2)',
          }}
        >
          <p className="text-cinema-cream font-medium mb-2">
            You have an unfinished session — you reacted up to {mins}:{secs.toString().padStart(2, '0')}.
            Resume from where you left off?
          </p>
          <div className="flex gap-3">
            <button
              onClick={resumeSession}
              className="px-4 py-2 rounded text-sm font-medium"
              style={{ backgroundColor: 'var(--cinema-gold)', color: 'var(--cinema-dark)' }}
            >
              Resume
            </button>
            <button
              onClick={() => startNewSession(true)}
              className="px-4 py-2 rounded text-sm text-cinema-muted border border-cinema-border hover:border-cinema-gold/40 transition-colors"
            >
              Start Over
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div
        className="rounded-lg p-4 flex items-center justify-between"
        style={{
          background: 'linear-gradient(135deg, rgba(200,169,81,0.15), rgba(200,169,81,0.05))',
          border: '1px solid rgba(200,169,81,0.2)',
        }}
      >
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-cinema-gold">⚡ Live Reaction Mode</span>
          <span
            className="text-xs px-2 py-0.5 rounded-full font-bold"
            style={{
              backgroundColor: isPlaying ? 'var(--cinema-teal)' : '#666',
              color: 'var(--cinema-card)',
            }}
          >
            {isPlaying ? 'LIVE' : 'PAUSED'}
          </span>
        </div>
      </div>

      {!session && (
        <div className="bg-cinema-gold/10 border border-cinema-gold/20 rounded-lg p-3 text-center">
          <span className="text-sm text-cinema-gold">
            Sign in to react — your reactions help shape the sentiment graph
          </span>
        </div>
      )}

      {/* Timer */}
      <div className="bg-cinema-darker rounded-lg border border-cinema-border p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="font-mono text-2xl text-cinema-cream">{formatTimer(elapsed)}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="px-4 py-1.5 rounded text-sm font-medium transition-colors"
              style={{
                backgroundColor: isPlaying ? '#ef4444' : 'var(--cinema-teal)',
                color: 'var(--cinema-card)',
              }}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>
            <button
              onClick={handleReset}
              className="px-3 py-1.5 rounded text-sm text-cinema-muted border border-cinema-border hover:border-cinema-gold/40 transition-colors"
            >
              ↺ Reset
            </button>
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1.5 bg-cinema-card rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-cinema-gold transition-all duration-1000"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-cinema-muted/60 mt-1">
          <span>0:00</span>
          <span>{runtime ? `${Math.floor(runtime / 60)}h ${runtime % 60}m` : '2h 00m'}</span>
        </div>
      </div>

      {/* Reaction Buttons */}
      <div className="bg-cinema-darker rounded-lg border border-cinema-border p-4 space-y-3">
        <p className="text-xs text-cinema-muted uppercase tracking-wider">Quick Reactions</p>
        <div className="grid grid-cols-2 gap-2">
          {REACTIONS.slice(0, 2).map((r) => (
            <button
              key={r.key}
              onClick={() => handleReaction(r.key)}
              disabled={cooldown}
              className="flex items-center justify-center gap-2 py-3 rounded-lg border transition-all duration-200 disabled:opacity-40"
              style={{
                borderColor: `${r.color}40`,
                backgroundColor: `${r.color}10`,
              }}
              onMouseEnter={(e) => {
                if (!cooldown) e.currentTarget.style.backgroundColor = `${r.color}30`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = `${r.color}10`
              }}
            >
              <span className="text-2xl">{r.emoji}</span>
              <div className="text-left">
                <span className="text-sm text-cinema-cream block">{r.label}</span>
                <span className="text-[10px] text-cinema-muted">{r.weight}</span>
              </div>
            </button>
          ))}
        </div>
        <p className="text-xs text-cinema-muted uppercase tracking-wider mt-2">More Reactions</p>
        <div className="grid grid-cols-3 gap-2">
          {REACTIONS.slice(2).map((r) => (
            <button
              key={r.key}
              onClick={() => handleReaction(r.key)}
              disabled={cooldown}
              className="flex flex-col items-center py-3 rounded-lg border transition-all duration-200 disabled:opacity-40"
              style={{
                borderColor: `${r.color}40`,
                backgroundColor: `${r.color}10`,
              }}
              onMouseEnter={(e) => {
                if (!cooldown) e.currentTarget.style.backgroundColor = `${r.color}30`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = `${r.color}10`
              }}
            >
              <span className="text-2xl">{r.emoji}</span>
              <span className="text-xs text-cinema-cream">{r.label}</span>
              <span className="text-[10px] text-cinema-muted">{r.weight}</span>
            </button>
          ))}
        </div>
        {cooldown && (
          <p className="text-xs text-cinema-muted text-center">Cooldown — wait 10s between reactions</p>
        )}
      </div>

      {/* Live Graph Canvas */}
      <div className="bg-cinema-darker rounded-lg border border-cinema-border p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-cinema-muted uppercase tracking-wider">Your Sentiment</p>
          <span
            className="font-[family-name:var(--font-bebas)] text-2xl"
            style={{
              color:
                currentScore >= 8 ? 'var(--cinema-teal)' : currentScore >= 6 ? 'var(--cinema-gold)' : '#ef4444',
            }}
          >
            {currentScore.toFixed(1)}
          </span>
        </div>
        <canvas
          ref={canvasRef}
          className="w-full rounded"
          style={{ height: 200 }}
        />
        <div className="flex justify-between text-[10px] text-cinema-muted/60 mt-1">
          <span>1 — Hated it</span>
          <span>5 — Neutral</span>
          <span>10 — Masterpiece</span>
        </div>
      </div>

      {/* Last Reaction */}
      {lastReaction && (
        <div className="text-center text-sm text-cinema-muted">
          Last: {lastReaction.emoji} → Score:{' '}
          <span className="text-cinema-gold font-bold">{lastReaction.score.toFixed(1)}</span>
        </div>
      )}

      {error && (
        <p className="text-red-400 text-sm text-center">{error}</p>
      )}
    </div>
  )
}
