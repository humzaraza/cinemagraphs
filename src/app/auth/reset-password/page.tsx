'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[80vh] flex items-center justify-center px-4">
        <div className="w-5 h-5 border-2 border-cinema-gold/40 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  )
}

function ResetPasswordForm() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error)
      } else {
        setSuccess(true)
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-cinema-darker border border-cinema-border rounded-xl p-8 text-center">
          <h1 className="font-[family-name:var(--font-playfair)] text-2xl font-bold text-cinema-gold mb-4">
            Invalid Link
          </h1>
          <p className="text-sm text-cinema-muted mb-6">
            This password reset link is invalid or has expired.
          </p>
          <Link
            href="/auth/signin"
            className="text-cinema-gold hover:underline text-sm"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  if (success) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-cinema-darker border border-cinema-border rounded-xl p-8 text-center">
          <h1 className="font-[family-name:var(--font-playfair)] text-2xl font-bold text-cinema-gold mb-4">
            Password Reset
          </h1>
          <p className="text-sm text-cinema-muted mb-6">
            Your password has been reset successfully.
          </p>
          <Link
            href="/auth/signin"
            className="inline-block bg-cinema-gold/90 hover:bg-cinema-gold text-cinema-dark font-semibold py-2.5 px-6 rounded-lg transition-colors"
          >
            Sign In
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-cinema-darker border border-cinema-border rounded-xl p-8">
        <div className="text-center mb-8">
          <h1 className="font-[family-name:var(--font-playfair)] text-3xl font-bold text-cinema-gold mb-2">
            New Password
          </h1>
          <p className="text-sm text-cinema-muted">
            Enter your new password below.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="block text-sm text-cinema-muted mb-1.5">
              New Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 8 characters"
              required
              minLength={8}
              className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-4 py-2.5 text-white placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/50 transition-colors"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="confirmPassword" className="block text-sm text-cinema-muted mb-1.5">
              Confirm Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={8}
              className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-4 py-2.5 text-white placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/50 transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-cinema-gold/90 hover:bg-cinema-gold text-cinema-dark font-semibold py-2.5 rounded-lg transition-colors disabled:opacity-60"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-cinema-dark/40 border-t-transparent rounded-full animate-spin mx-auto" />
            ) : (
              'Reset Password'
            )}
          </button>
        </form>

        {error && (
          <p className="text-red-400 text-xs text-center mt-3">{error}</p>
        )}

        <Link
          href="/auth/signin"
          className="block text-xs text-cinema-muted hover:text-cinema-gold text-center mt-5"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
