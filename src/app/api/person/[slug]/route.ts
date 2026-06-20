import { NextResponse } from 'next/server'
import { getPersonData } from '@/lib/person-data'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params

  // Extract tmdbPersonId from slug (last segment after final dash)
  const lastDash = slug.lastIndexOf('-')
  if (lastDash === -1) {
    return NextResponse.json({ error: 'Invalid slug' }, { status: 400 })
  }
  const tmdbPersonId = parseInt(slug.slice(lastDash + 1), 10)
  if (isNaN(tmdbPersonId)) {
    return NextResponse.json({ error: 'Invalid slug' }, { status: 400 })
  }

  const data = await getPersonData(tmdbPersonId)

  if (!data) {
    return NextResponse.json({ error: 'Person not found' }, { status: 404 })
  }

  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' },
  })
}
