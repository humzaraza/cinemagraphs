'use client'

import { useState, useEffect, useCallback } from 'react'
import { signIn } from 'next-auth/react'

type Mode = 'signin' | 'register' | 'verify'

export default function SignInPage() {
  const [honeypot, setHoneypot] = useState('')
  const [mode, setMode] = useState<Mode>('signin')
  const [loading, setLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)
  const [forgotMode, setForgotMode] = useState(false)

  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCooldown])

  const handleResendCode = useCallback(async () => {
    if (resendCooldown > 0) return
    setResendCooldown(30)
    setError(null)
    try {
      const res = await fetch('/api/auth/resend-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error)
      } else {
        setMessage('A new code has been sent to your email.')
      }
    } catch {
      setError('Failed to resend code. Please try again.')
    }
  }, [email, resendCooldown])

  async function handleForgotPassword() {
    setError(null)
    setMessage(null)
    if (!email) {
      setError('Please enter your email address first.')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error)
      } else {
        setMessage(data.message)
        setForgotMode(true)
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleOAuthSignIn(provider: string) {
    if (honeypot) {
      setOauthLoading(provider)
      setTimeout(() => setOauthLoading(null), 3000)
      return
    }
    setOauthLoading(provider)
    setError(null)
    try {
      await signIn(provider, { callbackUrl: '/' })
    } catch {
      setError('Something went wrong. Please try again.')
      setOauthLoading(null)
    }
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (honeypot) {
      setLoading(true)
      setTimeout(() => setLoading(false), 3000)
      return
    }

    setLoading(true)
    setError(null)
    setMessage(null)

    try {
      if (mode === 'register') {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name }),
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data.error)
        } else {
          setMessage('Verification code sent! Check your email.')
          setMode('verify')
        }
      } else if (mode === 'verify') {
        const res = await fetch('/api/auth/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, code: otpCode }),
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data.error)
        } else {
          // Auto sign in after verification
          const result = await signIn('credentials', {
            email,
            password,
            redirect: false,
          })
          if (result?.error) {
            setError('Verified! Please sign in with your email and password.')
            setMode('signin')
          } else {
            window.location.href = '/'
          }
        }
      } else {
        // Sign in
        const result = await signIn('credentials', {
          email,
          password,
          redirect: false,
        })
        if (result?.error) {
          setError('Invalid email or password.')
        } else {
          window.location.href = '/'
        }
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-cinema-darker border border-cinema-border rounded-xl p-8">
        <div className="text-center mb-8">
          <h1 className="font-[family-name:var(--font-playfair)] text-3xl font-bold text-cinema-gold mb-2">
            {forgotMode ? 'Check Your Email' : mode === 'verify' ? 'Verify Email' : 'Welcome Back'}
          </h1>
          <p className="text-sm text-cinema-muted">
            {forgotMode
              ? 'If an account exists, a reset link has been sent.'
              : mode === 'verify'
              ? 'Enter the 6-digit code sent to your email.'
              : 'Sign in to access your collections and more.'}
          </p>
        </div>

        {/* Honeypot field */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', opacity: 0, height: 0, overflow: 'hidden' }}>
          <label htmlFor="_hp_website">Website</label>
          <input
            type="text"
            id="_hp_website"
            name="_hp_website"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
          />
        </div>

        {mode !== 'verify' && (
          <>
            {/* OAuth buttons */}
            <div className="space-y-3 mb-6">
              <button
                onClick={() => handleOAuthSignIn('google')}
                disabled={!!oauthLoading}
                className="w-full flex items-center justify-center gap-3 bg-white text-gray-800 font-medium py-2.5 px-4 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-60"
              >
                {oauthLoading === 'google' ? (
                  <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                  </svg>
                )}
                {oauthLoading === 'google' ? 'Redirecting...' : 'Continue with Google'}
              </button>

              <button
                onClick={() => handleOAuthSignIn('apple')}
                disabled={!!oauthLoading}
                className="w-full flex items-center justify-center gap-3 bg-black text-white font-medium py-2.5 px-4 rounded-lg hover:bg-gray-900 transition-colors disabled:opacity-60 border border-gray-700"
              >
                {oauthLoading === 'apple' ? (
                  <div className="w-5 h-5 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
                  </svg>
                )}
                {oauthLoading === 'apple' ? 'Redirecting...' : 'Continue with Apple'}
              </button>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3 mb-6">
              <div className="flex-1 h-px bg-cinema-border" />
              <span className="text-xs text-cinema-muted uppercase tracking-wider">or continue with email</span>
              <div className="flex-1 h-px bg-cinema-border" />
            </div>
          </>
        )}

        {/* Email/Password form */}
        <form onSubmit={handleEmailSubmit} className="space-y-4">
          {mode === 'verify' ? (
            <div>
              <label htmlFor="otp" className="block text-sm text-cinema-muted mb-1.5">
                Verification Code
              </label>
              <input
                id="otp"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-4 py-2.5 text-white text-center text-2xl tracking-[0.5em] placeholder:text-cinema-muted/40 placeholder:tracking-[0.5em] focus:outline-none focus:border-cinema-gold/50 transition-colors"
                autoFocus
              />
            </div>
          ) : (
            <>
              {mode === 'register' && (
                <div>
                  <label htmlFor="name" className="block text-sm text-cinema-muted mb-1.5">
                    Name
                  </label>
                  <input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-4 py-2.5 text-white placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/50 transition-colors"
                  />
                </div>
              )}
              <div>
                <label htmlFor="email" className="block text-sm text-cinema-muted mb-1.5">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-4 py-2.5 text-white placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/50 transition-colors"
                />
              </div>
              <div>
                <label htmlFor="password" className="block text-sm text-cinema-muted mb-1.5">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'register' ? 'Min 8 characters' : '••••••••'}
                  required
                  minLength={mode === 'register' ? 8 : undefined}
                  className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-4 py-2.5 text-white placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/50 transition-colors"
                />
                {mode === 'signin' && (
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    className="text-xs text-cinema-muted hover:text-cinema-gold mt-1.5 float-right"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
            </>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-cinema-gold/90 hover:bg-cinema-gold text-cinema-dark font-semibold py-2.5 rounded-lg transition-colors disabled:opacity-60"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-cinema-dark/40 border-t-transparent rounded-full animate-spin mx-auto" />
            ) : mode === 'register' ? (
              'Create Account'
            ) : mode === 'verify' ? (
              'Verify'
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {error && (
          <p className="text-red-400 text-xs text-center mt-3">{error}</p>
        )}
        {message && (
          <p className="text-green-400 text-xs text-center mt-3">{message}</p>
        )}

        {/* Mode toggle */}
        {mode !== 'verify' && (
          <p className="text-xs text-cinema-muted text-center mt-5">
            {mode === 'signin' ? (
              <>
                Don&apos;t have an account?{' '}
                <button
                  onClick={() => { setMode('register'); setError(null); setMessage(null); setForgotMode(false) }}
                  className="text-cinema-gold hover:underline"
                >
                  Create one
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button
                  onClick={() => { setMode('signin'); setError(null); setMessage(null); setForgotMode(false) }}
                  className="text-cinema-gold hover:underline"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        )}

        {mode === 'verify' && (
          <div className="flex flex-col items-center gap-2 mt-4">
            <button
              type="button"
              onClick={handleResendCode}
              disabled={resendCooldown > 0}
              className="text-xs text-cinema-gold hover:underline disabled:text-cinema-muted disabled:no-underline"
            >
              {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
            </button>
            <button
              onClick={() => { setMode('register'); setError(null); setMessage(null); setOtpCode(''); setResendCooldown(0) }}
              className="text-xs text-cinema-muted hover:text-cinema-gold"
            >
              Back to registration
            </button>
          </div>
        )}

        <p className="text-xs text-cinema-muted text-center mt-6">
          By signing in, you agree to our terms of service.
        </p>
      </div>
    </div>
  )
}
