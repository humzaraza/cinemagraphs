import { NextRequest } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { getMovieImages } from '@/lib/tmdb'

export const dynamic = 'force-dynamic'

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p'
const FULL_SIZE = 'w1280'
const THUMB_SIZE = 'w342'

type BackdropOut = {
  url: string
  thumbUrl: string
  width: number
  height: number
  voteAverage: number
  voteCount: number
  aspectRatio: number
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filmId: string }> },
) {
  const auth = await requireRole('ADMIN')
  if (!auth.authorized) return auth.errorResponse!

  const { filmId } = await params

  if (!filmId || typeof filmId !== 'string') {
    return Response.json({ error: 'filmId is required' }, { status: 400 })
  }

  const film = await prisma.film.findUnique({
    where: { id: filmId },
    select: { tmdbId: true },
  })

  if (!film) {
    return Response.json({ error: 'Film not found' }, { status: 404 })
  }

  if (film.tmdbId == null) {
    return Response.json({ backdrops: [] })
  }

  // TMDB failures resolve to empty list so the picker can render
  // "no stills available" rather than surface a 500 to the UI.
  let raw
  try {
    raw = await getMovieImages(film.tmdbId)
  } catch {
    return Response.json({ backdrops: [] })
  }

  const backdrops: BackdropOut[] = [...raw.backdrops]
    .sort(
      (a, b) =>
        b.vote_count - a.vote_count || b.vote_average - a.vote_average,
    )
    .map((img) => ({
      url: `${TMDB_IMAGE_BASE}/${FULL_SIZE}${img.file_path}`,
      thumbUrl: `${TMDB_IMAGE_BASE}/${THUMB_SIZE}${img.file_path}`,
      width: img.width,
      height: img.height,
      voteAverage: img.vote_average,
      voteCount: img.vote_count,
      aspectRatio: img.height > 0 ? img.width / img.height : 0,
    }))

  return Response.json({ backdrops })
}
