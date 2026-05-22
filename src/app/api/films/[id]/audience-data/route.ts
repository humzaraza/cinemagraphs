import { apiLogger } from '@/lib/logger'
import { getFilmAudienceData } from '@/lib/film-detail'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: filmId } = await params
    return Response.json(await getFilmAudienceData(filmId))
  } catch (err) {
    apiLogger.error({ err }, 'Failed to fetch audience data')
    return Response.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
