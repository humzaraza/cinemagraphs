import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { generateHybridAndStore } from '@/lib/sentiment-pipeline'
import { apiLogger } from '@/lib/logger'
import { invalidateFilmCache, invalidateHomepageCache } from '@/lib/cache'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getMobileOrServerSession()
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 403 })
  }

  const { id } = await params

  try {
    // Admin "Regenerate" button is an explicit force-regenerate; bypass the
    // review-hash skip that the cron uses to avoid duplicate work. Write goes
    // through safeWriteSentimentGraph so existing user beat ratings are not
    // orphaned by a label rewrite.
    await generateHybridAndStore(id, {
      force: true,
      callerPath: 'admin-analyze',
    })
    await Promise.all([invalidateFilmCache(id), invalidateHomepageCache()])
    return Response.json({ success: true, filmId: id })
  } catch (err) {
    apiLogger.error({ err, filmId: id }, 'Film analysis failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
