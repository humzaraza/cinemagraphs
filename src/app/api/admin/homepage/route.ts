import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const [featured, settings] = await Promise.all([
    prisma.featuredFilm.findMany({
      orderBy: { position: 'asc' },
      include: { film: { select: { id: true, title: true, posterUrl: true, tmdbId: true } } },
    }),
    prisma.siteSettings.findUnique({ where: { key: 'homepage_sections' } }),
  ])

  // If no curated featured films, return the current fallback (top rated with graphs)
  let effectiveFeatured = featured
  if (featured.length === 0) {
    const fallbackFilms = await prisma.film.findMany({
      where: { status: 'ACTIVE', sentimentGraph: { isNot: null } },
      select: { id: true, title: true, posterUrl: true, tmdbId: true },
      take: 5,
      orderBy: { sentimentGraph: { overallScore: 'desc' } },
    })
    effectiveFeatured = fallbackFilms.map((f, i) => ({
      id: `fallback-${i}`,
      filmId: f.id,
      position: i + 1,
      film: f,
    }))
  }

  return Response.json({
    featured: effectiveFeatured,
    isFallback: featured.length === 0,
    sectionVisibility: settings?.value ?? {
      inTheaters: true,
      topRated: true,
      biggestSwings: true,
      latestTrailers: true,
      browseByGenre: true,
    },
  })
}

// Save featured films
export async function PUT(request: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user || session.user.role !== 'ADMIN') {
    return Response.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const { action } = body

  if (action === 'featured') {
    const { filmIds } = body as { filmIds: string[] }
    if (!Array.isArray(filmIds) || filmIds.length > 6) {
      return Response.json({ error: 'Max 6 featured films' }, { status: 400 })
    }

    // Delete all existing, then insert new ones
    await prisma.featuredFilm.deleteMany()
    if (filmIds.length > 0) {
      await prisma.featuredFilm.createMany({
        data: filmIds.map((filmId, i) => ({ filmId, position: i + 1 })),
      })
      // Also update isFeatured flags
      await prisma.film.updateMany({ where: { isFeatured: true }, data: { isFeatured: false } })
      await prisma.film.updateMany({ where: { id: { in: filmIds } }, data: { isFeatured: true } })
    }

    return Response.json({ ok: true })
  }

  if (action === 'sections') {
    const { visibility } = body as { visibility: Record<string, boolean> }
    await prisma.siteSettings.upsert({
      where: { key: 'homepage_sections' },
      update: { value: visibility },
      create: { key: 'homepage_sections', value: visibility },
    })
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 })
}
