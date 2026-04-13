import { NextRequest } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { generateAndStoreWikiBeats } from '@/lib/wiki-beat-fallback'
import { invalidateFilmCache } from '@/lib/cache'
import { apiLogger } from '@/lib/logger'

export const maxDuration = 60

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getMobileOrServerSession()
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 403 })
  }

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const force = body.force === true

  try {
    const result = await generateAndStoreWikiBeats(id, { force })
    if (result.status === 'generated') {
      await invalidateFilmCache(id)
    }
    return Response.json({ filmId: id, ...result })
  } catch (err) {
    apiLogger.error({ err, filmId: id }, 'Wiki beat generation failed')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
