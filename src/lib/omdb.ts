import { cachedQuery, KEYS, TTL } from './cache'

const OMDB_API_KEY = process.env.OMDB_API_KEY
const OMDB_BASE_URL = 'https://www.omdbapi.com'

export interface AnchorScores {
  imdbRating: number | null
  rtCriticsScore: number | null
  rtAudienceScore: number | null
  metacriticScore: number | null
}

interface OMDBResponse {
  Response: string
  imdbRating?: string
  Ratings?: { Source: string; Value: string }[]
  Metascore?: string
  Error?: string
}

async function fetchAnchorScoresRaw(imdbId: string): Promise<AnchorScores> {
  if (!OMDB_API_KEY) {
    console.warn('[OMDB] No API key configured, skipping anchor score fetch')
    return { imdbRating: null, rtCriticsScore: null, rtAudienceScore: null, metacriticScore: null }
  }

  const url = `${OMDB_BASE_URL}/?i=${encodeURIComponent(imdbId)}&apikey=${OMDB_API_KEY}`
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`[OMDB] HTTP ${res.status} for ${imdbId}`)
    return { imdbRating: null, rtCriticsScore: null, rtAudienceScore: null, metacriticScore: null }
  }

  const data: OMDBResponse = await res.json()
  if (data.Response === 'False') {
    console.warn(`[OMDB] ${data.Error} for ${imdbId}`)
    return { imdbRating: null, rtCriticsScore: null, rtAudienceScore: null, metacriticScore: null }
  }

  const imdbRating = data.imdbRating && data.imdbRating !== 'N/A'
    ? parseFloat(data.imdbRating)
    : null

  let rtCriticsScore: number | null = null
  const rtAudienceScore: number | null = null

  if (data.Ratings) {
    const rt = data.Ratings.find(r => r.Source === 'Rotten Tomatoes')
    if (rt) {
      const parsed = parseInt(rt.Value.replace('%', ''), 10)
      if (!isNaN(parsed)) rtCriticsScore = parsed
    }
  }

  const metacriticScore = data.Metascore && data.Metascore !== 'N/A'
    ? parseInt(data.Metascore, 10)
    : null

  return { imdbRating, rtCriticsScore, rtAudienceScore, metacriticScore }
}

/** Fetch anchor scores with 24-hour Redis cache */
export async function fetchAnchorScores(imdbId: string): Promise<AnchorScores> {
  return cachedQuery(KEYS.omdb(imdbId), TTL.OMDB, () => fetchAnchorScoresRaw(imdbId))
}
