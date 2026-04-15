'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Image from 'next/image'
import Link from 'next/link'
import { tmdbImageUrl } from '@/lib/utils'
import { ListSparkline } from '@/components/ListSparkline'
import AddFilmsModal from '@/components/AddFilmsModal'

interface ListFilm {
  id: string
  title: string
  posterUrl: string | null
  year: number | null
  runtime: number | null
  genres: string[]
  score: number | null
  sparklineData: number[] | null
  addedAt: string
}

interface ListDetail {
  id: string
  name: string
  genreTag: string | null
  description: string | null
  isPublic: boolean
  filmCount: number
  createdAt: string
  updatedAt: string
  owner: {
    id: string
    name: string | null
    username: string | null
    image: string | null
  }
  films: ListFilm[]
}

export default function ListDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { data: session } = useSession()
  const listId = params.id as string

  const [list, setList] = useState<ListDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [addFilmsOpen, setAddFilmsOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [privacySaving, setPrivacySaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState('')

  const fetchList = useCallback(() => {
    setLoading(true)
    fetch(`/api/lists/${listId}`)
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}))
          throw new Error(data.error || 'List not found')
        }
        return r.json()
      })
      .then((data: ListDetail) => {
        setList(data)
        setEditName(data.name)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [listId])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  const isOwner = !!(session?.user?.id && list && session.user.id === list.owner.id)

  const handleSaveName = async () => {
    if (!list || !editName.trim() || editName.trim() === list.name) {
      setEditing(false)
      setEditName(list?.name || '')
      return
    }
    setSavingName(true)
    setActionError('')
    try {
      const res = await fetch(`/api/user/lists/${listId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to rename list')
      }
      setList({ ...list, name: editName.trim() })
      setEditing(false)
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setSavingName(false)
    }
  }

  const handleTogglePrivacy = async () => {
    if (!list) return
    setPrivacySaving(true)
    setActionError('')
    const nextPublic = !list.isPublic
    try {
      const res = await fetch(`/api/user/lists/${listId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublic: nextPublic }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update privacy')
      }
      setList({ ...list, isPublic: nextPublic })
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setPrivacySaving(false)
    }
  }

  const handleDeleteList = async () => {
    if (!list) return
    setDeleting(true)
    setActionError('')
    try {
      const res = await fetch(`/api/user/lists/${listId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to delete list')
      }
      router.push(`/profile/${list.owner.id}`)
    } catch (err) {
      setActionError((err as Error).message)
      setDeleting(false)
    }
  }

  const handleRemoveFilm = async (filmId: string) => {
    if (!list) return
    setActionError('')
    const prevFilms = list.films
    setList({
      ...list,
      films: list.films.filter((f) => f.id !== filmId),
      filmCount: Math.max(0, list.filmCount - 1),
    })
    try {
      const res = await fetch(`/api/user/lists/${listId}/films/${filmId}`, {
        method: 'DELETE',
      })
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to remove film')
      }
    } catch (err) {
      setActionError((err as Error).message)
      setList({ ...list, films: prevFilms, filmCount: prevFilms.length })
    }
  }

  const handleFilmAdded = () => {
    // Refetch to get fresh film data (poster, sparkline, runtime, etc.)
    fetchList()
  }

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-12">
        <div className="animate-pulse space-y-4">
          <div className="h-4 w-32 bg-cinema-card rounded" />
          <div className="h-8 w-64 bg-cinema-card rounded" />
          <div className="h-4 w-40 bg-cinema-card rounded" />
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 pt-6">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="aspect-[27/40] bg-cinema-card rounded" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (error || !list) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-12 text-center">
        <p className="text-cinema-muted text-lg">{error || 'List not found'}</p>
        <Link href="/" className="text-cinema-gold text-sm mt-4 inline-block hover:underline">
          Back home
        </Link>
      </div>
    )
  }

  const existingFilmIds = new Set(list.films.map((f) => f.id))
  const ownerName = list.owner.name || list.owner.username || 'User'

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Back link */}
      <Link
        href={`/profile/${list.owner.id}`}
        className="inline-flex items-center gap-1.5 text-xs text-cinema-muted hover:text-cinema-cream transition-colors mb-5"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        <span>Back to profile</span>
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-3">
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={80}
                autoFocus
                className="font-[family-name:var(--font-playfair)] text-2xl sm:text-[28px] font-semibold bg-cinema-dark border border-cinema-gold/40 rounded-lg px-3 py-1.5 text-cinema-cream focus:outline-none focus:border-cinema-gold"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName()
                  if (e.key === 'Escape') {
                    setEditing(false)
                    setEditName(list.name)
                  }
                }}
              />
              <button
                onClick={handleSaveName}
                disabled={savingName || !editName.trim()}
                className="text-xs font-semibold px-3 py-1.5 rounded-md bg-cinema-gold text-cinema-dark disabled:opacity-50"
              >
                {savingName ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => {
                  setEditing(false)
                  setEditName(list.name)
                }}
                className="text-xs text-cinema-muted hover:text-cinema-cream transition-colors px-2"
              >
                Cancel
              </button>
            </div>
          ) : (
            <h1 className="font-[family-name:var(--font-playfair)] text-2xl sm:text-[28px] font-semibold text-cinema-cream leading-tight">
              {list.name}
            </h1>
          )}
          <p className="text-xs text-cinema-muted mt-1">
            by{' '}
            <Link
              href={`/profile/${list.owner.id}`}
              className="hover:text-cinema-cream transition-colors"
            >
              {ownerName}
            </Link>
          </p>
        </div>

        {isOwner && !editing && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-md transition-colors border border-cinema-border text-cinema-muted hover:text-cinema-cream hover:border-cinema-gold/40"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              Edit
            </button>
            <button
              onClick={() => setAddFilmsOpen(true)}
              className="flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-md transition-colors hover:bg-cinema-gold/10"
              style={{
                color: '#C8A951',
                border: '1px solid rgba(200,169,81,0.4)',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add films
            </button>
          </div>
        )}
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        {list.genreTag && (
          <span
            className="text-[11px] font-semibold tracking-wide px-2.5 py-1 rounded-full"
            style={{
              color: '#C8A951',
              background: 'rgba(200,169,81,0.08)',
              border: '1px solid rgba(200,169,81,0.25)',
            }}
          >
            {list.genreTag}
          </span>
        )}
        <span className="text-xs text-cinema-muted">
          {list.filmCount} {list.filmCount === 1 ? 'film' : 'films'}
        </span>
        {!list.isPublic && (
          <span className="flex items-center gap-1 text-[11px] text-cinema-muted">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Private
          </span>
        )}
      </div>

      {/* Owner-only privacy toggle */}
      {isOwner && (
        <div
          className="flex items-center justify-between gap-4 p-3 rounded-lg mb-5"
          style={{
            background: 'rgba(245,240,225,0.02)',
            border: '1px solid rgba(200,169,81,0.08)',
          }}
        >
          <div className="min-w-0">
            <p className="text-sm text-cinema-cream font-medium">
              {list.isPublic ? 'Public list' : 'Private list'}
            </p>
            <p className="text-xs text-cinema-muted mt-0.5">
              {list.isPublic
                ? 'Anyone can view this list from your profile.'
                : 'Only you can see this list.'}
            </p>
          </div>
          <button
            onClick={handleTogglePrivacy}
            disabled={privacySaving}
            role="switch"
            aria-checked={list.isPublic}
            className="relative flex-shrink-0 w-10 h-6 rounded-full transition-colors disabled:opacity-60"
            style={{
              background: list.isPublic ? '#C8A951' : 'rgba(245,240,225,0.15)',
            }}
          >
            <span
              className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-cinema-dark transition-transform"
              style={{
                transform: list.isPublic ? 'translateX(16px)' : 'translateX(0)',
              }}
            />
          </button>
        </div>
      )}

      {actionError && (
        <p className="text-xs text-red-400 mb-3">{actionError}</p>
      )}

      {/* Film grid */}
      {list.films.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-16">
          <p className="text-sm text-cinema-muted mb-2">No films in this list yet.</p>
          {isOwner && (
            <button
              onClick={() => setAddFilmsOpen(true)}
              className="text-xs font-semibold px-4 py-2 rounded-md transition-colors mt-2"
              style={{
                color: '#C8A951',
                border: '1px solid rgba(200,169,81,0.4)',
                background: 'rgba(200,169,81,0.08)',
              }}
            >
              Add your first film
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {list.films.map((film) => (
            <FilmGridCard
              key={film.id}
              film={film}
              isOwner={isOwner}
              onRemove={() => handleRemoveFilm(film.id)}
            />
          ))}
        </div>
      )}

      {/* Owner: delete list link at bottom */}
      {isOwner && (
        <div className="mt-10 pt-6 border-t border-cinema-border/50">
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-cinema-cream">
                Delete this list? This cannot be undone.
              </p>
              <button
                onClick={handleDeleteList}
                disabled={deleting}
                className="text-xs font-semibold px-3 py-1.5 rounded-md bg-red-500/90 text-white hover:bg-red-500 disabled:opacity-60"
              >
                {deleting ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-xs text-cinema-muted hover:text-cinema-cream transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-red-400/70 hover:text-red-400 transition-colors"
            >
              Delete this list
            </button>
          )}
        </div>
      )}

      {/* Add Films Modal */}
      {addFilmsOpen && (
        <AddFilmsModal
          listId={listId}
          existingFilmIds={existingFilmIds}
          onClose={() => setAddFilmsOpen(false)}
          onAdded={handleFilmAdded}
        />
      )}
    </div>
  )
}

function FilmGridCard({
  film,
  isOwner,
  onRemove,
}: {
  film: ListFilm
  isOwner: boolean
  onRemove: () => void
}) {
  const scores = film.sparklineData ?? []

  return (
    <div className="group relative">
      <Link href={`/films/${film.id}`} className="block">
        <div className="relative aspect-[27/40] rounded-lg overflow-hidden bg-cinema-card">
          {film.posterUrl ? (
            <Image
              src={tmdbImageUrl(film.posterUrl, 'w342')}
              alt={film.title}
              fill
              unoptimized
              className="object-cover transition-transform duration-200 group-hover:scale-[1.02]"
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 20vw"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-cinema-muted text-[10px] px-2 text-center">
              {film.title}
            </div>
          )}
        </div>
        <div className="mt-1.5">
          <ListSparkline scores={scores} runtime={film.runtime} />
        </div>
      </Link>

      {isOwner && (
        <button
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${film.title} from list`}
          className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{
            background: 'rgba(13,13,26,0.85)',
            border: '1px solid rgba(245,240,225,0.2)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#F5F0E1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  )
}
