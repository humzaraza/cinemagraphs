'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'

interface MemberUser {
  id: string
  name: string
  username: string | null
  image: string | null
  bio: string | null
  reviewCount: number
  followerCount: number
  followingCount: number
}

export default function MembersPage() {
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<MemberUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchUsers = useCallback(async (q: string, p: number, append: boolean) => {
    if (!q.trim()) {
      setUsers([])
      setTotal(0)
      setTotalPages(0)
      setSearched(false)
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(q.trim())}&page=${p}&limit=20`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      setUsers((prev) => (append ? [...prev, ...data.users] : data.users))
      setTotal(data.total)
      setPage(data.page)
      setTotalPages(data.totalPages)
      setSearched(true)
    } catch {
      if (!append) {
        setUsers([])
        setTotal(0)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchUsers(query, 1, false)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, fetchUsers])

  const handleLoadMore = () => {
    fetchUsers(query, page + 1, true)
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="font-[family-name:var(--font-playfair)] text-3xl font-bold text-cinema-cream mb-6">
        Members
      </h1>

      {/* Search bar */}
      <div className="relative mb-8">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 text-cinema-muted"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search members..."
          className="w-full pl-10 pr-4 py-3 rounded-lg bg-cinema-card border border-cinema-border text-cinema-cream placeholder:text-cinema-muted focus:outline-none focus:border-cinema-gold/50 transition-colors text-sm"
        />
      </div>

      {/* Default state */}
      {!searched && !loading && (
        <p className="text-center text-cinema-muted py-12 text-sm">
          Search for members by name or username
        </p>
      )}

      {/* Loading (initial search) */}
      {loading && users.length === 0 && (
        <div className="flex justify-center py-12">
          <div
            className="w-6 h-6 border-2 border-cinema-gold/30 border-t-cinema-gold rounded-full animate-spin"
          />
        </div>
      )}

      {/* No results */}
      {searched && !loading && users.length === 0 && (
        <p className="text-center text-cinema-muted py-12 text-sm">
          No members found for &ldquo;{query}&rdquo;
        </p>
      )}

      {/* Results grid */}
      {users.length > 0 && (
        <>
          <p className="text-xs text-cinema-muted mb-4">
            {total} {total === 1 ? 'member' : 'members'} found
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {users.map((user) => (
              <MemberCard key={user.id} user={user} />
            ))}
          </div>

          {/* Load more */}
          {page < totalPages && (
            <div className="flex justify-center mt-8">
              <button
                onClick={handleLoadMore}
                disabled={loading}
                className="text-sm font-medium px-6 py-2.5 rounded-lg border border-cinema-border text-cinema-cream hover:border-cinema-gold/50 hover:text-cinema-gold transition-colors disabled:opacity-50"
              >
                {loading ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function MemberCard({ user }: { user: MemberUser }) {
  const initial = (user.name || '?')[0].toUpperCase()

  return (
    <Link
      href={`/profile/${user.id}`}
      className="group block rounded-xl p-4 transition-all duration-200"
      style={{
        background: 'rgba(245,240,225,0.02)',
        border: '1px solid rgba(200,169,81,0.08)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(200,169,81,0.3)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(200,169,81,0.08)'
      }}
    >
      <div className="flex items-center gap-3">
        {user.image ? (
          <Image
            src={user.image}
            alt={user.name}
            width={44}
            height={44}
            className="rounded-full"
          />
        ) : (
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center text-base font-bold shrink-0"
            style={{
              background: 'linear-gradient(135deg, #C8A951, #a08530)',
              color: '#0D0D1A',
            }}
          >
            {initial}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-cinema-cream truncate">
            {user.name}
          </p>
          {user.username && (
            <p className="text-xs text-cinema-muted truncate">@{user.username}</p>
          )}
        </div>
      </div>
      <div className="flex gap-4 mt-3 ml-14">
        <span className="text-xs text-cinema-muted">
          <span className="font-semibold text-cinema-cream">{user.reviewCount}</span> reviews
        </span>
        <span className="text-xs text-cinema-muted">
          <span className="font-semibold text-cinema-cream">{user.followerCount}</span> followers
        </span>
      </div>
    </Link>
  )
}
