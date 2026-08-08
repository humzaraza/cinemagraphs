import { notFound } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import type { Metadata } from 'next'
import { canViewReview, getReviewById } from '@/lib/review-detail'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import ReviewComments from '@/components/ReviewComments'
import ReviewBeatOverlay from '@/components/ReviewBeatOverlay'
import { formatReviewProse } from '@/lib/review-prose'
import { buildBeatOverlay } from '@/lib/beat-overlay'
import { tmdbImageUrl, formatDate, truncate } from '@/lib/utils'
import type { SentimentDataPoint } from '@/lib/types'

// Per-review page with no public cache layer yet (see review-detail.ts on
// why the fetch is uncached), so render dynamically like the film page.
export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ id: string }> }

const NOT_FOUND_METADATA: Metadata = { title: 'Review Not Found | Cinemagraphs' }

// One geometry for the gate, the legend counts, and the rendered svg, so the
// legend can never describe a different overlay than the one drawn.
const GRAPH_GEOMETRY = { width: 600, height: 120, padding: 6 }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params

  const [found, session] = await Promise.all([
    getReviewById(id),
    getMobileOrServerSession().catch(() => null),
  ])
  if (!found) return NOT_FOUND_METADATA

  // Same visibility rule as the page render: a review the viewer may not
  // see gets the metadata of a review that does not exist, so the title and
  // description never leak a hidden review's contents.
  const { status, userId: authorId, ...review } = found
  if (!canViewReview(status, authorId, session?.user?.id ?? null)) return NOT_FOUND_METADATA

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

  // The session decides visibility for a non-approved review (owner only)
  // and personalizes the comment thread (composer vs sign-in prompt,
  // owner-only delete controls).
  const [found, session] = await Promise.all([
    getReviewById(id),
    getMobileOrServerSession().catch(() => null),
  ])

  if (!found) notFound()

  // status and userId exist only for the visibility check; destructure them
  // off so nothing below can render moderation state. A review the viewer
  // may not see 404s exactly like a missing id, matching
  // GET /api/reviews/[id], so the response does not reveal it exists.
  const { status, userId: authorId, ...review } = found
  if (!canViewReview(status, authorId, session?.user?.id ?? null)) notFound()

  const { film, user } = review
  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : null
  const prose = formatReviewProse(review) || review.combinedText || ''
  const dataPoints =
    (film.sentimentGraph?.dataPoints as unknown as SentimentDataPoint[] | null) ?? []
  const beatRatings = review.beatRatings as Record<string, number> | null
  // Same run/dot rule the svg draws with; a legacy row holding null, {}, or
  // only unmatched labels renders no graph block and no legend.
  const overlay = buildBeatOverlay(dataPoints, beatRatings, GRAPH_GEOMETRY)
  const hasGraph = dataPoints.length > 1 && overlay.ratedCount > 0

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
                    className="rounded-full object-cover"
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
            <ReviewBeatOverlay
              dataPoints={dataPoints}
              beatRatings={beatRatings}
              width={GRAPH_GEOMETRY.width}
              height={GRAPH_GEOMETRY.height}
              padding={GRAPH_GEOMETRY.padding}
              strokeWidth={2}
              dashArray="5 3"
              dotRadius={3.5}
            />
            <div className="flex items-center gap-4 text-[10px] text-cinema-muted">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-4 border-t-2 border-cinema-gold/60" />
                Film arc
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-4 border-t-2 border-dashed border-cinema-teal/80" />
                This review&apos;s beats ({overlay.ratedCount} of {overlay.totalBeats})
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
