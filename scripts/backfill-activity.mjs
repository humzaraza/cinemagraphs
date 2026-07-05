/**
 * One-off backfill: seed the Activity table from existing UserReviews and
 * Follows so the friend-activity feed has history from day one.
 *
 * Scope (deliberately narrow, Phase 1):
 *   - UserReview  -> { type: 'review', actorId: review author, reviewId,
 *                      filmId, createdAt: review's original createdAt }
 *     Only reviews with status 'approved'. Note: the schema's status values
 *     are approved | flagged | rejected (prisma/schema.prisma, UserReview);
 *     'approved' is the publicly-visible state every listing filters on.
 *   - Follow      -> { type: 'follow', actorId: follower,
 *                      targetUserId: followed, createdAt: follow's original
 *                      createdAt }
 *   - NO likes, NO replies, NO watchlist. Later phases decide those.
 *
 * Idempotent: re-running skips rows that already have an Activity with the
 * same (type, actorId, reviewId) or (type, actorId, targetUserId). Activity
 * has no unique constraint on those columns, so the skip is done here, not
 * by the database.
 *
 * Prerequisites (run by a human, in order; DATABASE_URL is the shared
 * prod/preview Neon database, so get explicit go-ahead first):
 *   1. npx prisma migrate deploy   (applies 20260703221246_add_activity)
 *   2. npx prisma generate         (client gains prisma.activity)
 *   3. npx tsx scripts/backfill-activity.mjs
 *
 * Run via tsx (not plain node): the generated Prisma client and the two
 * side-effect helpers below are TypeScript.
 */
import './_load-env'
import './_neon-ws'
import { prisma } from '../src/lib/prisma'

const BATCH_SIZE = 500

async function createInBatches(rows, label) {
  let created = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const result = await prisma.activity.createMany({ data: batch })
    created += result.count
    console.log(`  ${label}: inserted ${created}/${rows.length}`)
  }
  return created
}

async function backfillReviews() {
  const [existing, reviews] = await Promise.all([
    prisma.activity.findMany({
      where: { type: 'review' },
      select: { actorId: true, reviewId: true },
    }),
    prisma.userReview.findMany({
      where: { status: 'approved' },
      select: { id: true, userId: true, filmId: true, createdAt: true },
    }),
  ])

  const seen = new Set(existing.map((a) => `${a.actorId}|${a.reviewId}`))
  const rows = reviews
    .filter((r) => !seen.has(`${r.userId}|${r.id}`))
    .map((r) => ({
      type: 'review',
      actorId: r.userId,
      reviewId: r.id,
      filmId: r.filmId,
      createdAt: r.createdAt,
    }))

  console.log(
    `reviews: ${reviews.length} approved, ${reviews.length - rows.length} already backfilled, ${rows.length} to insert`
  )
  return createInBatches(rows, 'reviews')
}

async function backfillFollows() {
  const [existing, follows] = await Promise.all([
    prisma.activity.findMany({
      where: { type: 'follow' },
      select: { actorId: true, targetUserId: true },
    }),
    prisma.follow.findMany({
      select: { followerId: true, followingId: true, createdAt: true },
    }),
  ])

  const seen = new Set(existing.map((a) => `${a.actorId}|${a.targetUserId}`))
  const rows = follows
    .filter((f) => !seen.has(`${f.followerId}|${f.followingId}`))
    .map((f) => ({
      type: 'follow',
      actorId: f.followerId,
      targetUserId: f.followingId,
      createdAt: f.createdAt,
    }))

  console.log(
    `follows: ${follows.length} total, ${follows.length - rows.length} already backfilled, ${rows.length} to insert`
  )
  return createInBatches(rows, 'follows')
}

async function main() {
  const reviewCount = await backfillReviews()
  const followCount = await backfillFollows()
  console.log(`done: ${reviewCount} review activities, ${followCount} follow activities created`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
