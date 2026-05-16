'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signIn, signOut, useSession } from 'next-auth/react'

export default function Navigation() {
  const pathname = usePathname()
  const { data: session } = useSession()
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Close drawer on route change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO(lint): sync-external-state pattern; revisit when migrating to derived state
    setDrawerOpen(false)
  }, [pathname])

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [drawerOpen])

  const navLinks = [
    { href: '/films/browse', label: 'Browse' },
    { href: '/members', label: 'Members' },
    { href: '/categories', label: 'Categories' },
    { href: '/about', label: 'About' },
    ...(session?.user?.role === 'ADMIN' ? [{ href: '/admin', label: 'Admin' }] : []),
  ]

  return (
    <>
      <nav className="border-b border-cinema-border bg-cinema-darker/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14 md:h-20">
            <Link href="/" className="flex flex-col flex-shrink-0">
              <span className="font-[family-name:var(--font-playfair)] text-xl md:text-3xl font-bold text-cinema-gold leading-tight" style={{ borderBottom: '1px dashed rgba(200, 169, 81, 0.5)', paddingBottom: '2px' }}>
                Cinemagraphs
              </span>
              <span className="font-[family-name:var(--font-dm-sans)] text-xs leading-tight hidden md:block" style={{ color: 'rgba(255,255,255,0.4)' }}>
                Movie reviews, visualized.
              </span>
            </Link>

            {/* Mobile hamburger */}
            <button
              onClick={() => setDrawerOpen(true)}
              className="md:hidden flex items-center justify-center w-10 h-10"
              aria-label="Open menu"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--cinema-gold)" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>

            {/* Desktop nav */}
            <div className="hidden md:flex items-center gap-6">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`text-sm transition-colors ${
                    pathname === link.href
                      ? 'text-cinema-gold'
                      : 'text-cinema-cream/70 hover:text-cinema-cream'
                  }`}
                >
                  {link.label}
                </Link>
              ))}

              {session ? (
                <div className="flex items-center gap-3">
                  <Link
                    href={`/profile/${session.user?.id}`}
                    className="text-sm text-cinema-muted hover:text-cinema-gold transition-colors"
                  >
                    {session.user?.name || session.user?.email}
                  </Link>
                  <button
                    onClick={() => signOut()}
                    className="text-sm text-cinema-cream/70 hover:text-cinema-cream transition-colors"
                  >
                    Sign Out
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => signIn()}
                  className="text-sm bg-cinema-gold/10 text-cinema-gold border border-cinema-gold/30 px-4 py-1.5 rounded hover:bg-cinema-gold/20 transition-colors"
                >
                  Sign In
                </button>
              )}
            </div>
          </div>
        </div>
      </nav>

      {/* Mobile drawer overlay */}
      <div
        className={`fixed inset-0 z-[60] md:hidden transition-opacity duration-250 ${
          drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
        onClick={() => setDrawerOpen(false)}
      />

      {/* Mobile drawer */}
      <div
        className={`fixed top-0 right-0 bottom-0 z-[70] md:hidden w-72 flex flex-col transition-transform duration-250 ease-out ${
          drawerOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ backgroundColor: 'var(--cinema-dark)' }}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'rgba(200,169,110,0.15)' }}>
          {session ? (
            <Link
              href={`/profile/${session.user?.id}`}
              className="flex items-center gap-3"
              onClick={() => setDrawerOpen(false)}
            >
              <div
                className="flex items-center justify-center rounded-full font-semibold text-sm"
                style={{ width: 36, height: 36, backgroundColor: 'var(--cinema-gold)', color: 'var(--cinema-dark)' }}
              >
                {(session.user?.name || session.user?.email || '?').charAt(0).toUpperCase()}
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-cinema-cream">
                  {session.user?.name || 'User'}
                </span>
                {session.user?.email && session.user?.name && (
                  <span className="text-xs text-cinema-muted truncate max-w-[150px]">
                    {session.user.email}
                  </span>
                )}
              </div>
            </Link>
          ) : (
            <span className="text-sm text-cinema-muted">Menu</span>
          )}
          <button
            onClick={() => setDrawerOpen(false)}
            className="flex items-center justify-center w-8 h-8"
            aria-label="Close menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--cinema-gold)" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Nav links */}
        <div className="flex-1 py-2">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setDrawerOpen(false)}
              className={`block px-5 py-3.5 text-sm font-medium transition-colors ${
                pathname === link.href
                  ? 'text-cinema-gold bg-cinema-gold/5'
                  : 'text-cinema-cream/70 hover:text-cinema-cream hover:bg-white/[0.03]'
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>

        {/* Bottom action */}
        <div className="px-5 py-5 border-t" style={{ borderColor: 'rgba(200,169,110,0.15)' }}>
          {session ? (
            <button
              onClick={() => { setDrawerOpen(false); signOut() }}
              className="w-full text-left text-sm text-cinema-cream/70 hover:text-cinema-cream transition-colors"
            >
              Sign Out
            </button>
          ) : (
            <button
              onClick={() => { setDrawerOpen(false); signIn() }}
              className="w-full text-sm bg-cinema-gold/10 text-cinema-gold border border-cinema-gold/30 px-4 py-2 rounded hover:bg-cinema-gold/20 transition-colors"
            >
              Sign In
            </button>
          )}
        </div>
      </div>
    </>
  )
}
