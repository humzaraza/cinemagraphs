'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signIn, signOut, useSession } from 'next-auth/react'

export default function Navigation() {
  const pathname = usePathname()
  const { data: session } = useSession()

  return (
    <nav className="border-b border-cinema-border bg-cinema-darker/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href="/" className="flex items-center gap-2">
            <span className="font-[family-name:var(--font-playfair)] text-2xl font-bold text-cinema-gold">
              Cinemagraphs
            </span>
          </Link>

          <div className="flex items-center gap-6">
            <Link
              href="/films/browse"
              className={`text-sm transition-colors ${
                pathname === '/films/browse'
                  ? 'text-cinema-gold'
                  : 'text-cinema-cream/70 hover:text-cinema-cream'
              }`}
            >
              Browse
            </Link>
            <Link
              href="/categories"
              className={`text-sm transition-colors ${
                pathname === '/categories'
                  ? 'text-cinema-gold'
                  : 'text-cinema-cream/70 hover:text-cinema-cream'
              }`}
            >
              Categories
            </Link>

            {session?.user?.role === 'ADMIN' && (
              <Link
                href="/admin"
                className={`text-sm transition-colors ${
                  pathname === '/admin'
                    ? 'text-cinema-gold'
                    : 'text-cinema-cream/70 hover:text-cinema-cream'
                }`}
              >
                Admin
              </Link>
            )}

            {session ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-cinema-muted">
                  {session.user?.name || session.user?.email}
                </span>
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
  )
}
