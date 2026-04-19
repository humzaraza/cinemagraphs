import { NextRequest } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
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
  const confirmOrphanRisk = body.confirmOrphanRisk === true

  try {
    // Gate on UserReview presence. Wiki beat regeneration rewrites labels,
    // which can orphan user beat ratings whose labels no longer match. The
    // caller must acknowledge via confirmOrphanRisk: true.
    if (!confirmOrphanRisk) {
      const userReviewCount = await prisma.userReview.count({ where: { filmId: id } })
      if (userReviewCount > 0) {
        const film = await prisma.film.findUnique({
          where: { id },
          select: { id: true, title: true },
        })
        return Response.json(
          {
            requiresConfirmation: true,
            warning:
              'The following films have user reviews whose beat ratings may be affected by beat regeneration',
            affectedFilms: [
              {
                id,
                title: film?.title ?? null,
                userReviewCount,
              },
            ],
          },
          { status: 409 }
        )
      }
    }

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
