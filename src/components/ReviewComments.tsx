'use client'

import { useState, useEffect } from 'react'
import { signIn } from 'next-auth/react'
import Image from 'next/image'
import Link from 'next/link'

interface ReplyUser {
  id: string
  name: string | null
  image: string | null
}

interface ReplyData {
  id: string
  body: string
  createdAt: string
  parentReplyId: string | null
  user: ReplyUser
}

interface CommentData extends ReplyData {
  children: ReplyData[]
}

interface Props {
  reviewId: string
  currentUserId?: string
}

/**
 * Two-level comment thread for the standalone review page. Top-level
 * comments accept replies; replies do not (mirrors the POST route's
 * depth guard). Posting is not optimistic: the new entry renders only
 * from the server response, and on failure the typed text stays in the
 * box next to an inline error.
 */
export default function ReviewComments({ reviewId, currentUserId }: Props) {
  const [comments, setComments] = useState<CommentData[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/reviews/${reviewId}/replies`)
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const data = (await res.json()) as { comments: CommentData[] }
        if (!cancelled) setComments(data.comments)
      } catch {
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [reviewId])

  const total = comments.reduce((n, c) => n + 1 + c.children.length, 0)

  /** POST a reply; returns an error message to show inline, or null on success. */
  async function postReply(text: string, parentReplyId: string | null): Promise<string | null> {
    try {
      const res = await fetch(`/api/reviews/${reviewId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parentReplyId ? { body: text, parentReplyId } : { body: text }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        return (data && typeof data.error === 'string' && data.error) || 'Failed to post. Please try again.'
      }
      const reply = data as ReplyData
      if (parentReplyId) {
        setComments((prev) =>
          prev.map((c) => (c.id === parentReplyId ? { ...c, children: [...c.children, reply] } : c)),
        )
        setReplyingTo(null)
      } else {
        setComments((prev) => [...prev, { ...reply, children: [] }])
      }
      return null
    } catch {
      return 'Network error. Please try again.'
    }
  }

  /** DELETE a reply; on success prune it (and, for a comment, its children) from state. */
  async function deleteReply(replyId: string, parentId: string | null) {
    const res = await fetch(`/api/reviews/replies/${replyId}`, { method: 'DELETE' })
    if (!res.ok) return
    setComments((prev) =>
      parentId === null
        ? prev.filter((c) => c.id !== replyId)
        : prev.map((c) =>
            c.id === parentId ? { ...c, children: c.children.filter((ch) => ch.id !== replyId) } : c,
          ),
    )
  }

  function confirmDeleteComment(comment: CommentData) {
    const message =
      comment.children.length > 0
        ? 'Delete this comment? This will also delete its replies.'
        : 'Delete this comment?'
    if (!window.confirm(message)) return
    deleteReply(comment.id, null)
  }

  return (
    <div className="mt-8 bg-cinema-darker rounded-lg border border-cinema-border p-6 space-y-4">
      <h2 className="font-[family-name:var(--font-playfair)] text-lg text-cinema-cream">
        Comments{!loading && !loadError ? ` (${total})` : ''}
      </h2>

      {currentUserId ? (
        <Composer
          placeholder="Share your thoughts on this review"
          submitLabel="Comment"
          onSubmit={(text) => postReply(text, null)}
        />
      ) : (
        <div className="bg-cinema-gold/10 border border-cinema-gold/20 rounded-lg p-3 text-center">
          <span className="text-sm text-cinema-gold">
            <button
              type="button"
              onClick={() => signIn()}
              className="underline underline-offset-2 hover:text-cinema-gold/80"
            >
              Sign in
            </button>{' '}
            to join the discussion
          </span>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-cinema-muted">Loading comments...</p>
      ) : loadError ? (
        <p className="text-sm text-cinema-muted">Could not load comments. Try refreshing the page.</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-cinema-muted">
          {currentUserId ? 'No comments yet. Be the first.' : 'No comments yet.'}
        </p>
      ) : (
        <div className="space-y-5">
          {comments.map((comment) => (
            <div key={comment.id} className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <AuthorHeader user={comment.user} createdAt={comment.createdAt} />
                  {currentUserId === comment.user.id && (
                    <button
                      type="button"
                      onClick={() => confirmDeleteComment(comment)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  )}
                </div>
                <p className="text-sm text-cinema-cream/80 leading-relaxed whitespace-pre-line">
                  {comment.body}
                </p>
                {currentUserId && (
                  <button
                    type="button"
                    onClick={() => setReplyingTo(replyingTo === comment.id ? null : comment.id)}
                    className="text-xs text-cinema-muted hover:text-cinema-gold transition-colors"
                  >
                    Reply
                  </button>
                )}
              </div>

              {currentUserId && replyingTo === comment.id && (
                <div className="ml-9">
                  <Composer
                    placeholder="Write a reply"
                    submitLabel="Reply"
                    rows={2}
                    onSubmit={(text) => postReply(text, comment.id)}
                    onCancel={() => setReplyingTo(null)}
                  />
                </div>
              )}

              {comment.children.length > 0 && (
                <div className="ml-9 pl-4 border-l border-cinema-border space-y-3">
                  {comment.children.map((child) => (
                    <div key={child.id} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <AuthorHeader user={child.user} createdAt={child.createdAt} />
                        {currentUserId === child.user.id && (
                          <button
                            type="button"
                            onClick={() => deleteReply(child.id, comment.id)}
                            className="text-xs text-red-400 hover:text-red-300"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                      <p className="text-sm text-cinema-cream/80 leading-relaxed whitespace-pre-line">
                        {child.body}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AuthorHeader({ user, createdAt }: { user: ReplyUser; createdAt: string }) {
  return (
    <div className="flex items-center gap-2">
      {user.name ? (
        <Link href={`/profile/${user.id}`} className="flex items-center gap-2 group cursor-pointer">
          {user.image ? (
            <Image src={user.image} alt={user.name} width={28} height={28} className="rounded-full" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-cinema-gold/20 flex items-center justify-center text-cinema-gold text-xs">
              {user.name[0]}
            </div>
          )}
          <span className="text-sm text-cinema-cream group-hover:underline group-hover:decoration-cinema-gold/50 group-hover:underline-offset-2">
            {user.name}
          </span>
        </Link>
      ) : (
        <>
          <div className="w-7 h-7 rounded-full bg-cinema-gold/20 flex items-center justify-center text-cinema-gold text-xs">
            ?
          </div>
          <span className="text-sm text-cinema-cream">Anonymous</span>
        </>
      )}
      <span className="text-xs text-cinema-muted">{new Date(createdAt).toLocaleDateString()}</span>
    </div>
  )
}

/**
 * Non-optimistic composer. onSubmit resolves to an inline error message or
 * null on success; the typed text is cleared only on success, so a failed
 * post never loses the user's words.
 */
function Composer({
  placeholder,
  submitLabel,
  rows = 3,
  onSubmit,
  onCancel,
}: {
  placeholder: string
  submitLabel: string
  rows?: number
  onSubmit: (text: string) => Promise<string | null>
  onCancel?: () => void
}) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    const trimmed = text.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setError(null)
    const err = await onSubmit(trimmed)
    setSubmitting(false)
    if (err) {
      setError(err)
    } else {
      setText('')
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        maxLength={2000}
        disabled={submitting}
        className="w-full bg-cinema-card border border-cinema-border rounded-lg px-3 py-2 text-sm text-cinema-cream placeholder:text-cinema-muted/40 focus:outline-none focus:border-cinema-gold/40 resize-none disabled:opacity-60"
      />
      <div className="flex items-center gap-3">
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <div className="ml-auto flex items-center gap-3">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="text-xs text-cinema-muted hover:text-cinema-cream transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || text.trim().length === 0}
            className="text-sm px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
            style={{ backgroundColor: 'var(--cinema-gold)', color: 'var(--cinema-card)' }}
          >
            {submitting ? 'Posting...' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
