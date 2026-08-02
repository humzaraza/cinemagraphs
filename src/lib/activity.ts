import { prisma } from './prisma'
import { apiLogger } from './logger'

export type ActivityType = 'review' | 'follow' | 'watchlist' | 'like' | 'reply' | 'list_add'

export interface LogActivityInput {
  actorId: string
  type: ActivityType
  targetUserId?: string
  reviewId?: string
  filmId?: string
  replyId?: string
  listId?: string
}

/**
 * Write a row to the activity feed.
 *
 * Invariant: activity logging must never break the primary action. Any
 * failure is logged and swallowed; this function never throws.
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  try {
    await prisma.activity.create({ data: input })
  } catch (err) {
    apiLogger.error({ err, activity: input }, 'Failed to log activity')
  }
}
