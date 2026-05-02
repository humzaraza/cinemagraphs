import sharp from 'sharp'

export interface TmdbImageOpts {
  filmId?: string
}

interface NormalizedImage {
  buffer: Buffer
  mime: string
}

// Fetch a TMDB image and normalize it into a satori-compatible format.
//
// TMDB serves images via Cloudflare content negotiation, so the same URL can
// return JPEG, WebP, or AVIF depending on Accept headers and edge cache state.
// Satori's image handler cannot decode WebP or AVIF (it throws
// "u is not iterable" / "t is not iterable" in production builds), so anything
// other than JPEG/PNG is transcoded to JPEG via sharp. SVGs pass through with
// a viewBox injected if missing, since satori requires one.
//
// Returns null on any fetch or decode failure. Callers rely on null to skip
// the image and degrade gracefully rather than crash the whole render.
async function fetchAndNormalize(
  url: string,
  opts?: TmdbImageOpts,
): Promise<NormalizedImage | null> {
  try {
    // Hint Cloudflare/TMDB toward a satori-compatible format. Cloudflare may
    // still serve WebP/AVIF if its edge cache already holds one for this URL,
    // so the transcode below is the load-bearing safeguard.
    const res = await fetch(url, { headers: { Accept: 'image/jpeg, image/png' } })
    if (!res.ok) {
      console.error('[tmdb-image] Image fetch failed:', { url, status: res.status })
      return null
    }
    const contentType = res.headers.get('content-type') || 'image/jpeg'

    // Reject non-image responses (TMDB can return HTML error pages).
    if (!contentType.startsWith('image/')) {
      console.error('[tmdb-image] Non-image content-type, skipping:', { url, contentType })
      return null
    }

    const buf = Buffer.from(await res.arrayBuffer())

    // Satori requires SVGs to have a viewBox — inject one if missing.
    if (contentType.includes('svg') || url.endsWith('.svg')) {
      let svg = buf.toString('utf-8')
      if (!svg.includes('viewBox')) {
        const wMatch = svg.match(/width="([^"]+)"/)
        const hMatch = svg.match(/height="([^"]+)"/)
        if (wMatch && hMatch) {
          const w = parseFloat(wMatch[1])
          const h = parseFloat(hMatch[1])
          if (w && h) {
            svg = svg.replace('<svg', `<svg viewBox="0 0 ${w} ${h}"`)
          }
        } else {
          return null
        }
      }
      return { buffer: Buffer.from(svg, 'utf-8'), mime: 'image/svg+xml' }
    }

    // Transcode WebP/AVIF/anything-else to JPEG. PNG passes through.
    if (contentType !== 'image/jpeg' && contentType !== 'image/png') {
      const transcoded = await sharp(buf).jpeg({ quality: 85 }).toBuffer()
      console.log('[tmdb-image] Transcoded non-JPEG image to JPEG for satori compatibility:', {
        url,
        filmId: opts?.filmId ?? null,
        originalContentType: contentType,
        originalBytes: buf.length,
        transcodedBytes: transcoded.length,
      })
      return { buffer: transcoded, mime: 'image/jpeg' }
    }

    return { buffer: buf, mime: contentType }
  } catch (err) {
    console.error('[tmdb-image] Image fetch error:', { url, error: String(err) })
    return null
  }
}

// Returns the normalized image bytes as a Buffer (JPEG, PNG, or SVG).
// Null on fetch/decode failure.
export async function fetchTmdbImageAsBuffer(
  url: string,
  opts?: TmdbImageOpts,
): Promise<Buffer | null> {
  const norm = await fetchAndNormalize(url, opts)
  return norm?.buffer ?? null
}

// Returns the normalized image as a base64 data URI ready for satori's
// <img src=...> prop. Null on fetch/decode failure.
export async function fetchTmdbImageAsDataUri(
  url: string,
  opts?: TmdbImageOpts,
): Promise<string | null> {
  const norm = await fetchAndNormalize(url, opts)
  if (!norm) return null
  return `data:${norm.mime};base64,${norm.buffer.toString('base64')}`
}
