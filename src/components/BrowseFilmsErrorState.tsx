export type BrowseError =
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'generic' }

interface BrowseFilmsErrorStateProps {
  error: BrowseError
  variant: 'full' | 'banner'
  onRetry: () => void
}

const COPY = {
  generic: {
    title: 'Couldn’t load films',
    subtitle: 'Something went wrong on our end. Check your connection and try again.',
  },
  rate_limited: {
    title: 'Slow down a moment',
    subtitle:
      'You’ve made a lot of requests recently. Give it a few seconds before trying again.',
  },
} as const

function NetworkDownIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

function ClockIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  )
}

function RetryButton({ error, onRetry }: { error: BrowseError; onRetry: () => void }) {
  const counting = error.kind === 'rate_limited' && error.retryAfterSec > 0
  const label =
    error.kind === 'rate_limited' && error.retryAfterSec > 0
      ? `Try again in ${error.retryAfterSec}s`
      : 'Try again'

  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={counting}
      aria-disabled={counting}
      // The label re-renders every second while counting down; aria-live="off"
      // keeps a screen reader from announcing each tick.
      aria-live="off"
      className="inline-flex items-center justify-center gap-1.5 bg-transparent border border-cinema-gold text-cinema-gold rounded-[8px] px-[22px] py-[9px] text-[13px] font-medium transition-colors hover:bg-cinema-gold/10 disabled:opacity-50 disabled:hover:bg-transparent"
    >
      {error.kind === 'generic' && <RefreshIcon />}
      {label}
    </button>
  )
}

export default function BrowseFilmsErrorState({
  error,
  variant,
  onRetry,
}: BrowseFilmsErrorStateProps) {
  const copy = COPY[error.kind]
  const Icon = error.kind === 'rate_limited' ? ClockIcon : NetworkDownIcon

  if (variant === 'banner') {
    return (
      <div
        role="alert"
        aria-live="polite"
        className="flex flex-col items-start gap-3 sm:flex-row sm:items-center border border-cinema-border bg-cinema-darker/40 rounded-lg px-4 py-3 mb-6"
      >
        <span className="shrink-0 text-cinema-gold opacity-[0.85]">
          <Icon size={20} />
        </span>
        <p className="flex-1 text-[14px] leading-[1.5] text-cinema-muted">
          <span className="font-medium text-cinema-cream">{copy.title}.</span>{' '}
          {copy.subtitle}
        </p>
        <RetryButton error={error} onRetry={onRetry} />
      </div>
    )
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center text-center pt-14 px-4 pb-8"
    >
      <span className="mb-[14px] text-cinema-gold opacity-[0.85]">
        <Icon size={32} />
      </span>
      <p className="mb-[6px] text-[17px] font-medium text-cinema-cream">{copy.title}</p>
      <p className="mb-6 text-[14px] leading-[1.5] text-cinema-muted">{copy.subtitle}</p>
      <RetryButton error={error} onRetry={onRetry} />
    </div>
  )
}
