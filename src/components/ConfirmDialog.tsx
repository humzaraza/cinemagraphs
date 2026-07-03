'use client'

import { useEffect, useId, useRef } from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button when true (the default), gold otherwise. */
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * In-app replacement for window.confirm, styled like the app's modals
 * (EditProfileModal's overlay treatment). Escape and a backdrop click
 * cancel; focus moves to Cancel on open so Enter dismisses rather than
 * destroys, and Tab cycles between the two buttons while open.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  // Move focus into the dialog when it opens. Cancel is the safe default.
  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  // Escape cancels; Tab (and Shift+Tab) cycles between the two buttons so
  // focus stays inside the dialog. Listener lives only while open and is
  // removed on close and unmount.
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const next =
          document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current
        next?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-[360px] bg-cinema-darker border border-cinema-border rounded-xl shadow-2xl p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id={titleId}
          className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream"
        >
          {title}
        </h2>
        {message && <p className="text-sm text-cinema-muted leading-relaxed">{message}</p>}
        <div className="flex justify-end gap-3 pt-1">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="text-sm px-4 py-2 rounded-lg border border-cinema-border text-cinema-muted hover:text-cinema-cream hover:border-cinema-muted transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="text-sm px-4 py-2 rounded-lg font-medium transition-opacity hover:opacity-90"
            style={
              destructive
                ? { backgroundColor: '#ef4444', color: 'var(--cinema-card)' }
                : { backgroundColor: 'var(--cinema-gold)', color: 'var(--cinema-card)' }
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
