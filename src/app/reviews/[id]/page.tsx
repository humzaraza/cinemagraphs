import { notFound } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import type { Metadata } from 'next'
import { getReviewById } from '@/lib/review-detail'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import ReviewComments from '@/components/ReviewComments'
import { formatReviewProse } from '@/lib/review-prose'
import { tmdbImageUrl, formatDate, truncate } from '@/lib/utils'
import type { SentimentDataPoint } from '@/lib/types'

// Per-review page with no public cache layer yet (see review-detail.ts on
// why the fetch is uncached), so render dynamically like the film page.
export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const review = await getReviewById(id)
  if (!review) return { title: 'Review Not Found | Cinemagraphs' }

  const authorName = review.user.name ?? 'Anonymous'
  const title = `${authorName}'s review of ${review.film.title} | Cinemagraphs`
  const prose = review.combinedText ?? formatReviewProse(review)
  const description = prose
    ? truncate(prose, 160)
    : `A review of ${review.film.title} on Cinemagraphs.`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      ...(review.film.posterUrl && {
        images: [{ url: tmdbImageUrl(review.film.posterUrl, 'w500'), width: 500, height: 750 }],
      }),
    },
  }
}

export default async function ReviewPage({ params }: Props) {
  const { id } = await params

  // The page itself is public; the session only personalizes the comment
  // thread (composer vs sign-in prompt, owner-only delete controls).
  const [review, session] = await Promise.all([
    getReviewById(id),
    getMobileOrServerSession().catch(() => null),
  ])

  if (!review) notFound()

  const { film, user } = review
  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : null
  const prose = formatReviewProse(review) || review.combinedText || ''
  const dataPoints =
    (film.sentimentGraph?.dataPoints as unknown as SentimentDataPoint[] | null) ?? []
  const beatRatings = review.beatRatings as Record<string, number> | null
  const hasGraph = beatRatings !== null && dataPoints.length > 1

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      {/* Film context */}
      <div className="flex items-center gap-4 mb-6">
        <Link href={`/films/${film.id}`} className="shrink-0">
          {film.posterUrl ? (
            <Image
              src={tmdbImageUrl(film.posterUrl, 'w185')}
              alt={film.title}
              width={64}
              height={96}
              unoptimized
              className="rounded object-cover"
            />
          ) : (
            <div className="w-16 h-24 bg-cinema-card border border-cinema-border rounded flex items-center justify-center text-cinema-muted text-xs">
              No poster
            </div>
          )}
        </Link>
        <div className="min-w-0">
          <Link href={`/films/${film.id}`} className="hover:text-cinema-gold transition-colors">
            <h1 className="font-[family-name:var(--font-playfair)] text-2xl md:text-3xl font-bold text-cinema-cream leading-tight">
              {film.title}
            </h1>
          </Link>
          {(year !== null || film.director) && (
            <p className="text-sm text-cinema-muted mt-1">
              {[year, film.director].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </div>

      {/* Review */}
      <div className="bg-cinema-darker border border-cinema-border rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {user.name ? (
              <Link
                href={`/profile/${user.id}`}
                className="flex items-center gap-2 group cursor-pointer"
              >
                {user.image ? (
                  <Image
                    src={user.image}
                    alt={user.name}
                    width={36}
                    height={36}
                    className="rounded-full"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-cinema-gold/20 flex items-center justify-center text-cinema-gold text-sm">
                    {user.name[0]}
                  </div>
                )}
                <span className="text-sm text-cinema-cream group-hover:underline group-hover:decoration-cinema-gold/50 group-hover:underline-offset-2">
                  {user.name}
                </span>
              </Link>
            ) : (
              <>
                <div className="w-9 h-9 rounded-full bg-cinema-gold/20 flex items-center justify-center text-cinema-gold text-sm">
                  ?
                </div>
                <span className="text-sm text-cinema-cream">Anonymous</span>
              </>
            )}
            <span className="text-xs text-cinema-muted">{formatDate(review.createdAt)}</span>
          </div>
          <span
            className="text-sm font-bold px-2 py-0.5 rounded"
            style={{
              backgroundColor:
                review.overallRating >= 8
                  ? 'var(--cinema-teal)'
                  : review.overallRating >= 6
                    ? 'var(--cinema-gold)'
                    : '#ef4444',
              color: 'var(--cinema-card)',
            }}
          >
            {review.overallRating.toFixed(1)}
          </span>
        </div>

        {hasGraph && (
          <div className="space-y-1">
            <ReviewBeatGraph dataPoints={dataPoints} beatRatings={beatRatings} />
            <div className="flex items-center gap-4 text-[10px] text-cinema-muted">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-4 border-t-2 border-cinema-gold/60" />
                Film arc
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-4 border-t-2 border-dashed border-cinema-teal/80" />
                This review&apos;s beats
              </span>
            </div>
          </div>
        )}

        {prose && (
          <p className="text-sm text-cinema-cream/80 leading-relaxed whitespace-pre-line">
            {prose}
          </p>
        )}
      </div>

      <section id="comments">
        <ReviewComments reviewId={review.id} currentUserId={session?.user?.id} />
      </section>
    </div>
  )
}

/**
 * Server-rendered copy of the profile page's MiniGraph (a local, non-exported
 * function there) at page scale: the film's arc in gold, the reviewer's beat
 * ratings overlaid in dashed teal. Extract to a shared component when a third
 * caller appears.
 */
function ReviewBeatGraph({
  dataPoints,
  beatRatings,
}: {
  dataPoints: SentimentDataPoint[]
  beatRatings: Record<string, number>
}) {
  const width = 600
  const height = 120
  const padding = 6

  const goldPath = dataPoints
    .map((dp, i) => {
      const x = padding + (i / Math.max(dataPoints.length - 1, 1)) * (width - padding * 2)
      const y = height - padding - ((dp.score - 1) / 9) * (height - padding * 2)
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    })
    .join(' ')

  const matchedBeats = dataPoints
    .map((dp, i) => {
      const rating = beatRatings[dp.label]
      if (rating === undefined) return null
      const x = padding + (i / Math.max(dataPoints.length - 1, 1)) * (width - padding * 2)
      const y = height - padding - ((rating - 1) / 9) * (height - padding * 2)
      return { x, y }
    })
    .filter(Boolean) as { x: number; y: number }[]

  const tealPath = matchedBeats.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')

  return (
    <svg width={width} height={height} className="w-full" viewBox={`0 0 ${width} ${height}`}>
      {goldPath && (
        <path d={goldPath} fill="none" stroke="var(--cinema-gold)" strokeWidth="2" opacity="0.6" />
      )}
      {tealPath && (
        <path
          d={tealPath}
          fill="none"
          stroke="var(--cinema-teal)"
          strokeWidth="2"
          strokeDasharray="5 3"
          opacity="0.8"
        />
      )}
    </svg>
  )
}
