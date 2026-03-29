'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'

interface UserRow {
  id: string
  name: string | null
  email: string
  image: string | null
  role: string
  suspendedUntil: string | null
  createdAt: string
  reviewCount: number
  reactionCount: number
}

interface UsersResponse {
  users: UserRow[]
  total: number
  page: number
  totalPages: number
}

const ROLES = ['ALL', 'USER', 'MODERATOR', 'ADMIN', 'BANNED'] as const
const SORT_OPTIONS = [
  { value: 'createdAt', label: 'Newest first' },
  { value: 'name', label: 'Name A-Z' },
  { value: 'reviewCount', label: 'Most reviews' },
]

function roleBadge(role: string) {
  const colors: Record<string, string> = {
    ADMIN: 'bg-cinema-gold/20 text-cinema-gold border-cinema-gold/30',
    MODERATOR: 'bg-teal-500/20 text-teal-400 border-teal-500/30',
    USER: 'bg-white/10 text-cinema-muted border-white/10',
    BANNED: 'bg-red-500/20 text-red-400 border-red-500/30',
  }
  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded border ${colors[role] || colors.USER}`}>
      {role}
    </span>
  )
}

function suspensionBadge(until: string) {
  const date = new Date(until)
  const now = new Date()
  if (date <= now) return null
  const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
  return (
    <span className="px-2 py-0.5 text-xs font-medium rounded border bg-orange-500/20 text-orange-400 border-orange-500/30">
      Suspended until {formatted}
    </span>
  )
}

export default function AdminUsers() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('ALL')
  const [sort, setSort] = useState('createdAt')
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [roleChangeTarget, setRoleChangeTarget] = useState<{ id: string; name: string; currentRole: string; newRole: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; email: string } | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [suspendTarget, setSuspendTarget] = useState<{ id: string; name: string } | null>(null)
  const [suspendDuration, setSuspendDuration] = useState('24h')
  const [actionLoading, setActionLoading] = useState(false)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        sort,
        order: sort === 'name' ? 'asc' : 'desc',
      })
      if (search) params.set('search', search)
      if (roleFilter !== 'ALL') params.set('role', roleFilter)

      const res = await fetch(`/api/admin/users?${params}`)
      if (res.ok) {
        const data: UsersResponse = await res.json()
        setUsers(data.users)
        setTotal(data.total)
        setTotalPages(data.totalPages)
      }
    } finally {
      setLoading(false)
    }
  }, [page, search, roleFilter, sort])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  // Debounced search
  const [searchInput, setSearchInput] = useState('')
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  async function changeRole() {
    if (!roleChangeTarget) return
    setActionLoading(true)
    try {
      const res = await fetch(`/api/admin/users/${roleChangeTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: roleChangeTarget.newRole }),
      })
      if (res.ok) {
        setRoleChangeTarget(null)
        fetchUsers()
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to change role')
      }
    } finally {
      setActionLoading(false)
    }
  }

  async function deleteUser() {
    if (!deleteTarget || deleteConfirmText !== 'DELETE') return
    setActionLoading(true)
    try {
      const res = await fetch(`/api/admin/users/${deleteTarget.id}`, { method: 'DELETE' })
      if (res.ok) {
        setDeleteTarget(null)
        setDeleteConfirmText('')
        fetchUsers()
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to delete user')
      }
    } finally {
      setActionLoading(false)
    }
  }

  async function suspendUser() {
    if (!suspendTarget) return
    setActionLoading(true)
    try {
      let until: string
      const now = new Date()
      if (suspendDuration === '24h') until = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
      else if (suspendDuration === '7d') until = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
      else if (suspendDuration === '30d') until = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
      else until = suspendDuration // custom ISO date

      const res = await fetch(`/api/admin/users/${suspendTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suspendedUntil: until }),
      })
      if (res.ok) {
        setSuspendTarget(null)
        fetchUsers()
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to suspend user')
      }
    } finally {
      setActionLoading(false)
    }
  }

  async function unsuspendUser(id: string) {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suspendedUntil: null }),
    })
    if (res.ok) fetchUsers()
  }

  return (
    <div>
      {/* Filters bar */}
      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="flex-1 min-w-[200px] bg-cinema-dark border border-cinema-border rounded-lg px-4 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted focus:outline-none focus:border-cinema-gold/50"
        />
        <select
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value); setPage(1) }}
          className="bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2 text-sm text-cinema-cream focus:outline-none focus:border-cinema-gold/50"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>{r === 'ALL' ? 'All Roles' : r}</option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value); setPage(1) }}
          className="bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2 text-sm text-cinema-cream focus:outline-none focus:border-cinema-gold/50"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Total count */}
      <p className="text-sm text-cinema-muted mb-4">{total} user{total !== 1 ? 's' : ''} found</p>

      {/* Users table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-2 border-cinema-gold border-t-transparent rounded-full animate-spin" />
        </div>
      ) : users.length === 0 ? (
        <p className="text-cinema-muted text-center py-8">No users found.</p>
      ) : (
        <div className="border border-cinema-border rounded-lg overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[44px_1fr_1fr_100px_100px_80px_60px] gap-3 px-4 py-2.5 bg-cinema-card text-xs text-cinema-muted font-medium uppercase tracking-wider border-b border-cinema-border">
            <div />
            <div>Name</div>
            <div>Email</div>
            <div>Role</div>
            <div>Joined</div>
            <div className="text-center">Reviews</div>
            <div className="text-center">React</div>
          </div>

          {users.map((user) => {
            const isExpanded = expandedId === user.id
            const isSuspended = user.suspendedUntil && new Date(user.suspendedUntil) > new Date()
            return (
              <div key={user.id} className="border-b border-cinema-border last:border-b-0">
                {/* Main row */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : user.id)}
                  className="w-full grid grid-cols-[44px_1fr_1fr_100px_100px_80px_60px] gap-3 px-4 py-3 items-center text-left hover:bg-white/[0.02] transition-colors"
                >
                  {/* Avatar */}
                  <div className="w-9 h-9 rounded-full bg-cinema-border flex items-center justify-center overflow-hidden flex-shrink-0">
                    {user.image ? (
                      <Image src={user.image} alt="" width={36} height={36} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-sm text-cinema-muted font-medium">
                        {(user.name || user.email)[0].toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="truncate">
                    <span className="text-sm text-cinema-cream">{user.name || '—'}</span>
                    {isSuspended && (
                      <span className="ml-2 inline-block">{suspensionBadge(user.suspendedUntil!)}</span>
                    )}
                  </div>
                  <div className="text-sm text-cinema-muted truncate">{user.email}</div>
                  <div>{roleBadge(user.role)}</div>
                  <div className="text-sm text-cinema-muted">
                    {new Date(user.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                  </div>
                  <div className="text-sm text-cinema-cream text-center">{user.reviewCount}</div>
                  <div className="text-sm text-cinema-cream text-center">{user.reactionCount}</div>
                </button>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="px-4 pb-4 pt-1 bg-white/[0.01]">
                    <div className="flex flex-wrap gap-2">
                      {/* Role change */}
                      <select
                        value={user.role}
                        onChange={(e) => setRoleChangeTarget({
                          id: user.id,
                          name: user.name || user.email,
                          currentRole: user.role,
                          newRole: e.target.value,
                        })}
                        className="bg-cinema-dark border border-cinema-border rounded px-2 py-1.5 text-sm text-cinema-cream focus:outline-none focus:border-cinema-gold/50"
                      >
                        {['USER', 'MODERATOR', 'ADMIN', 'BANNED'].map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>

                      {/* Suspend / Unsuspend */}
                      {isSuspended ? (
                        <button
                          onClick={() => unsuspendUser(user.id)}
                          className="px-3 py-1.5 text-sm rounded border border-orange-500/30 text-orange-400 hover:bg-orange-500/10 transition-colors"
                        >
                          Unsuspend
                        </button>
                      ) : (
                        <button
                          onClick={() => setSuspendTarget({ id: user.id, name: user.name || user.email })}
                          className="px-3 py-1.5 text-sm rounded border border-orange-500/30 text-orange-400 hover:bg-orange-500/10 transition-colors"
                        >
                          Suspend
                        </button>
                      )}

                      {/* Delete */}
                      <button
                        onClick={() => setDeleteTarget({ id: user.id, name: user.name || '—', email: user.email })}
                        className="px-3 py-1.5 text-sm rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors ml-auto"
                      >
                        Delete Account
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-6">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 text-sm rounded border border-cinema-border text-cinema-muted hover:text-cinema-cream disabled:opacity-30 transition-colors"
          >
            Previous
          </button>
          <span className="text-sm text-cinema-muted">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 text-sm rounded border border-cinema-border text-cinema-muted hover:text-cinema-cream disabled:opacity-30 transition-colors"
          >
            Next
          </button>
        </div>
      )}

      {/* Role Change Confirmation Modal */}
      {roleChangeTarget && roleChangeTarget.newRole !== roleChangeTarget.currentRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }} onClick={() => setRoleChangeTarget(null)}>
          <div className="bg-cinema-card border border-cinema-border rounded-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream mb-3">
              Change Role
            </h3>
            <p className="text-sm text-cinema-muted mb-4">
              Change <span className="text-cinema-cream">{roleChangeTarget.name}</span> from{' '}
              {roleBadge(roleChangeTarget.currentRole)} to {roleBadge(roleChangeTarget.newRole)}?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setRoleChangeTarget(null)}
                className="px-4 py-2 text-sm rounded border border-cinema-border text-cinema-muted hover:text-cinema-cream transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={changeRole}
                disabled={actionLoading}
                className="px-4 py-2 text-sm rounded bg-cinema-gold text-cinema-dark font-semibold hover:bg-cinema-gold/90 transition-colors disabled:opacity-50"
              >
                {actionLoading ? 'Saving...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }} onClick={() => { setDeleteTarget(null); setDeleteConfirmText('') }}>
          <div className="bg-cinema-card border border-red-500/30 rounded-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-red-400 mb-3">
              Delete User Account
            </h3>
            <p className="text-sm text-cinema-muted mb-2">
              This will permanently delete <span className="text-cinema-cream">{deleteTarget.name}</span> ({deleteTarget.email}) and all their data including reviews, reactions, and sessions.
            </p>
            <p className="text-sm text-red-400 mb-4">This action cannot be undone.</p>
            <label className="block text-sm text-cinema-muted mb-2">
              Type <span className="text-cinema-cream font-mono">DELETE</span> to confirm:
            </label>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="DELETE"
              className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-4 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted focus:outline-none focus:border-red-500/50 mb-4"
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setDeleteTarget(null); setDeleteConfirmText('') }}
                className="px-4 py-2 text-sm rounded border border-cinema-border text-cinema-muted hover:text-cinema-cream transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={deleteUser}
                disabled={deleteConfirmText !== 'DELETE' || actionLoading}
                className="px-4 py-2 text-sm rounded bg-red-600 text-white font-semibold hover:bg-red-500 transition-colors disabled:opacity-30"
              >
                {actionLoading ? 'Deleting...' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Suspend Modal */}
      {suspendTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }} onClick={() => setSuspendTarget(null)}>
          <div className="bg-cinema-card border border-orange-500/30 rounded-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-orange-400 mb-3">
              Suspend User
            </h3>
            <p className="text-sm text-cinema-muted mb-4">
              Suspend <span className="text-cinema-cream">{suspendTarget.name}</span> for:
            </p>
            <div className="flex flex-wrap gap-2 mb-4">
              {[
                { value: '24h', label: '24 hours' },
                { value: '7d', label: '7 days' },
                { value: '30d', label: '30 days' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSuspendDuration(opt.value)}
                  className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                    suspendDuration === opt.value
                      ? 'border-orange-500 bg-orange-500/20 text-orange-400'
                      : 'border-cinema-border text-cinema-muted hover:text-cinema-cream'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <label className="block text-sm text-cinema-muted mb-1">Or custom date:</label>
            <input
              type="date"
              onChange={(e) => { if (e.target.value) setSuspendDuration(new Date(e.target.value + 'T23:59:59').toISOString()) }}
              className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-4 py-2 text-sm text-cinema-cream focus:outline-none focus:border-orange-500/50 mb-4"
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setSuspendTarget(null)}
                className="px-4 py-2 text-sm rounded border border-cinema-border text-cinema-muted hover:text-cinema-cream transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={suspendUser}
                disabled={actionLoading}
                className="px-4 py-2 text-sm rounded bg-orange-600 text-white font-semibold hover:bg-orange-500 transition-colors disabled:opacity-50"
              >
                {actionLoading ? 'Suspending...' : 'Suspend'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
