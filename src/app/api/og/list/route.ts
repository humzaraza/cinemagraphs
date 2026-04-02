import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import satori from 'satori'
import sharp from 'sharp'
import React from 'react'
import type { SentimentDataPoint } from '@/lib/types'

export const dynamic = 'force-dynamic'

const W = 1080
const BG = '#0D0D1A'
const GOLD = '#C8A951'
const TEAL = '#2DD4A8'
const RED = '#E05555'
const IVORY = '#F5F0E8'
const TMDB_API_KEY = process.env.TMDB_API_KEY!

// ── Font cache ──────────────────────────────────────────

const fontCache: Record<string, ArrayBuffer> = {}

async function loadFonts() {
  if (fontCache.baskerville && fontCache.baskervilleBold && fontCache.dmSans) {
    return {
      baskerville: fontCache.baskerville,
      baskervilleBold: fontCache.baskervilleBold,
      dmSans: fontCache.dmSans,
    }
  }

  const [baskervilleRes, baskervilleBoldRes, dmSansRes] = await Promise.all([
    fetch(
      'https://fonts.gstatic.com/s/librebaskerville/v24/kmKUZrc3Hgbbcjq75U4uslyuy4kn0olVQ-LglH6T17uj8Q4SCQ.ttf'
    ),
    fetch(
      'https://fonts.gstatic.com/s/librebaskerville/v24/kmKUZrc3Hgbbcjq75U4uslyuy4kn0olVQ-LglH6T17ujFgkSCQ.ttf'
    ),
    fetch(
      'https://fonts.gstatic.com/s/dmsans/v17/rP2rp2ywxg089UriCZaSExd86J3t9jz86Mvy4qCRAL19DksVat-JDW3z.ttf'
    ),
  ])

  fontCache.baskerville = await baskervilleRes.arrayBuffer()
  fontCache.baskervilleBold = await baskervilleBoldRes.arrayBuffer()
  fontCache.dmSans = await dmSansRes.arrayBuffer()

  return {
    baskerville: fontCache.baskerville,
    baskervilleBold: fontCache.baskervilleBold,
    dmSans: fontCache.dmSans,
  }
}

// ── Catmull-Rom sparkline with axis lines ───────────────

function catmullRomPath(
  points: { x: number; y: number }[],
  tension = 0.5
): string {
  if (points.length < 2) return ''
  const parts: string[] = [`M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`]

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]

    const cp1x = p1.x + ((p2.x - p0.x) / 6) * tension
    const cp1y = p1.y + ((p2.y - p0.y) / 6) * tension
    const cp2x = p2.x - ((p3.x - p1.x) / 6) * tension
    const cp2y = p2.y - ((p3.y - p1.y) / 6) * tension

    parts.push(
      `C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
    )
  }

  return parts.join(' ')
}

async function buildSparklinePng(
  dataPoints: SentimentDataPoint[],
  sw: number,
  sh: number
): Promise<string | null> {
  if (dataPoints.length < 2) return null

  const paddingX = 18
  const paddingY = 6
  const innerW = sw - paddingX * 2
  const innerH = sh - paddingY * 2

  // Dynamic y-axis scaling
  const scores = dataPoints.map((dp) => dp.score)
  const lowestScore = Math.min(...scores)
  const highestScore = Math.max(...scores)
  const yMin = Math.max(1, Math.floor(lowestScore) - 1)
  const yMax = Math.min(10, Math.ceil(highestScore) + 1)
  const yRange = yMax - yMin

  const points = dataPoints.map((dp, i) => ({
    x: paddingX + (i / (dataPoints.length - 1)) * innerW,
    y: paddingY + innerH - ((dp.score - yMin) / yRange) * innerH,
    score: dp.score,
  }))

  const peakIdx = points.reduce((best, p, i) => (p.score > points[best].score ? i : best), 0)
  const lowIdx = points.reduce((best, p, i) => (p.score < points[best].score ? i : best), 0)

  const path = catmullRomPath(points)

  const axisColor = 'rgba(232,228,220,0.5)'
  const neutralColor = 'rgba(232,228,220,0.3)'
  const labelColor = 'rgba(232,228,220,0.4)'

  // Midpoint dashed line
  const midScore = (yMin + yMax) / 2
  const midY = paddingY + innerH - ((midScore - yMin) / yRange) * innerH

  // Build raw SVG string with text labels (sharp supports SVG text)
  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}" viewBox="0 0 ${sw} ${sh}">`,
    // Y-axis left
    `<line x1="${paddingX}" y1="${paddingY}" x2="${paddingX}" y2="${paddingY + innerH}" stroke="${axisColor}" stroke-width="1"/>`,
    // Y-axis right
    `<line x1="${paddingX + innerW}" y1="${paddingY}" x2="${paddingX + innerW}" y2="${paddingY + innerH}" stroke="${axisColor}" stroke-width="1"/>`,
    // X-axis bottom
    `<line x1="${paddingX}" y1="${paddingY + innerH}" x2="${paddingX + innerW}" y2="${paddingY + innerH}" stroke="${axisColor}" stroke-width="1"/>`,
    // Dashed midpoint line
    `<line x1="${paddingX}" y1="${midY.toFixed(1)}" x2="${paddingX + innerW}" y2="${midY.toFixed(1)}" stroke="${neutralColor}" stroke-width="1" stroke-dasharray="4 3"/>`,
    // Y-axis labels — left side
    `<text x="${paddingX - 3}" y="${paddingY + 4}" text-anchor="end" fill="${labelColor}" font-family="sans-serif" font-size="8">${yMax}</text>`,
    `<text x="${paddingX - 3}" y="${paddingY + innerH}" text-anchor="end" fill="${labelColor}" font-family="sans-serif" font-size="8">${yMin}</text>`,
    // Y-axis labels — right side
    `<text x="${paddingX + innerW + 3}" y="${paddingY + 4}" text-anchor="start" fill="${labelColor}" font-family="sans-serif" font-size="8">${yMax}</text>`,
    `<text x="${paddingX + innerW + 3}" y="${paddingY + innerH}" text-anchor="start" fill="${labelColor}" font-family="sans-serif" font-size="8">${yMin}</text>`,
    // Data line
    `<path d="${path}" fill="none" stroke="${GOLD}" stroke-width="2.5" stroke-linecap="round"/>`,
    // Peak dot
    `<circle cx="${points[peakIdx].x.toFixed(1)}" cy="${points[peakIdx].y.toFixed(1)}" r="3.5" fill="${TEAL}"/>`,
  ]

  // Low dot only if below 7.5
  if (points[lowIdx].score < 7.5) {
    svgParts.push(
      `<circle cx="${points[lowIdx].x.toFixed(1)}" cy="${points[lowIdx].y.toFixed(1)}" r="3.5" fill="${RED}"/>`
    )
  }

  svgParts.push('</svg>')
  const svgStr = svgParts.join('\n')

  // Render SVG to PNG via sharp
  const png = await sharp(Buffer.from(svgStr))
    .png()
    .toBuffer()

  return `data:image/png;base64,${png.toString('base64')}`
}

// ── Image fetching (convert to base64 data URI for satori) ──

async function fetchImageAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') || 'image/jpeg'
    const buf = await res.arrayBuffer()

    // Satori requires SVGs to have a viewBox — inject one if missing
    if (contentType.includes('svg') || url.endsWith('.svg')) {
      let svg = Buffer.from(buf).toString('utf-8')
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
          // Can't determine dimensions — skip this SVG
          return null
        }
      }
      const base64 = Buffer.from(svg).toString('base64')
      return `data:image/svg+xml;base64,${base64}`
    }

    const base64 = Buffer.from(buf).toString('base64')
    return `data:${contentType};base64,${base64}`
  } catch {
    return null
  }
}

// ── Fetch TMDB logo for a film ──

async function fetchTmdbLogo(tmdbId: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}/images?include_image_language=en,null`,
      { headers: { Authorization: `Bearer ${TMDB_API_KEY}` } }
    )
    if (!res.ok) return null
    const data = await res.json()
    const logos = data.logos as { file_path: string; iso_639_1: string | null }[]
    if (!logos || logos.length === 0) return null
    // Prefer English logo, fall back to first
    const enLogo = logos.find((l) => l.iso_639_1 === 'en') ?? logos[0]
    return fetchImageAsDataUri(`https://image.tmdb.org/t/p/w300${enLogo.file_path}`)
  } catch {
    return null
  }
}

// ── Main route ──────────────────────────────────────────

export async function GET(request: NextRequest) {
  const auth = await requireRole('ADMIN')
  if (!auth.authorized) return auth.errorResponse!

  const url = request.nextUrl
  const filmIds = (url.searchParams.get('films') || '').split(',').filter(Boolean)
  const title = url.searchParams.get('title') || 'Top Films'
  const subtitle = url.searchParams.get('subtitle') || ''
  const displays = (url.searchParams.get('displays') || '').split(',')
  const crops = (url.searchParams.get('crops') || '').split(',')
  const sparkHeights = (url.searchParams.get('sparkHeights') || '').split(',')
  const ratio = url.searchParams.get('ratio') || '16:9'

  if (filmIds.length === 0) {
    return Response.json({ error: 'No films specified' }, { status: 400 })
  }
  if (filmIds.length > 15) {
    return Response.json({ error: 'Maximum 15 films' }, { status: 400 })
  }

  // Build display map: filmId -> 'logo' | 'font'
  const displayMap = new Map<string, string>()
  const cropMap = new Map<string, number>()
  const sparkHeightMap = new Map<string, number>()
  filmIds.forEach((id, i) => {
    displayMap.set(id, displays[i] === 'font' ? 'font' : 'logo')
    cropMap.set(id, crops[i] ? Math.max(0, Math.min(100, Number(crops[i]) || 30)) : 30)
    sparkHeightMap.set(id, sparkHeights[i] ? Math.max(50, Math.min(150, Number(sparkHeights[i]) || 90)) : 90)
  })

  // Fetch films with graph data
  const films = await prisma.film.findMany({
    where: { id: { in: filmIds } },
    select: {
      id: true,
      title: true,
      tmdbId: true,
      releaseDate: true,
      backdropUrl: true,
      sentimentGraph: {
        select: { overallScore: true, dataPoints: true },
      },
    },
  })

  // Preserve order from filmIds
  const filmMap = new Map(films.map((f) => [f.id, f]))
  const ordered = filmIds.map((id) => filmMap.get(id)).filter(Boolean) as typeof films

  if (ordered.length === 0) {
    return Response.json({ error: 'No matching films found' }, { status: 404 })
  }

  const fonts = await loadFonts()

  // Pre-fetch backdrop images + logos as base64 (parallel)
  const backdropCache = new Map<string, string | null>()
  const logoCache = new Map<string, string | null>()

  await Promise.all(
    ordered.flatMap((film) => {
      const tasks: Promise<void>[] = []
      // Backdrop image (full-width row background)
      if (film.backdropUrl) {
        tasks.push(
          fetchImageAsDataUri(`https://image.tmdb.org/t/p/w780${film.backdropUrl}`).then((uri) => {
            backdropCache.set(film.id, uri)
          })
        )
      }
      // Logo (only for films set to 'logo' display)
      if (displayMap.get(film.id) === 'logo') {
        tasks.push(
          fetchTmdbLogo(film.tmdbId).then((uri) => {
            logoCache.set(film.id, uri)
          })
        )
      }
      return tasks
    })
  )

  // ── Layout (ratio-aware) ──
  const DIMS: Record<string, { w: number; h: number }> = {
    '16:9': { w: 1080, h: 608 },
    '1:1': { w: 1080, h: 1080 },
    '4:5': { w: 1080, h: 1350 },
    '9:16': { w: 1080, h: 1920 },
  }
  const dim = DIMS[ratio] ?? DIMS['16:9']
  const totalH = dim.h
  const count = ordered.length

  // Scale header/footer based on available height
  const isTall = ratio === '9:16'
  const isSquareOrPortrait = ratio === '1:1' || ratio === '4:5'
  const headerH = isTall ? 200 : isSquareOrPortrait ? 150 : 120
  const footerH = isTall ? 100 : isSquareOrPortrait ? 80 : 60

  const rowSpace = totalH - headerH - footerH
  const rowH = Math.max(40, Math.floor(rowSpace / count))

  // Pre-render sparklines as PNGs with per-film dimensions (parallel)
  const sparklineCache = new Map<string, { uri: string; w: number; h: number }>()
  await Promise.all(
    ordered.map(async (film) => {
      const dataPoints = (film.sentimentGraph?.dataPoints as unknown as SentimentDataPoint[]) ?? []
      if (dataPoints.length >= 2) {
        const sh = sparkHeightMap.get(film.id) ?? 90
        const sw = Math.round(sh * 4.8)
        const uri = await buildSparklinePng(dataPoints, sw, sh)
        if (uri) sparklineCache.set(film.id, { uri, w: sw, h: sh })
      }
    })
  )

  // ── Build rows ──
  const rows = ordered.map((film, i) => {
    const year = film.releaseDate ? new Date(film.releaseDate).getFullYear().toString() : ''
    const score = film.sentimentGraph?.overallScore ?? null
    const backdropSrc = backdropCache.get(film.id) ?? null
    const cropY = cropMap.get(film.id) ?? 30
    const logoSrc = logoCache.get(film.id) ?? null
    const useLogo = displayMap.get(film.id) === 'logo' && logoSrc != null
    const sparkData = sparklineCache.get(film.id) ?? null

    const titleFontSize = rowH > 80 ? 22 : rowH > 60 ? 18 : 14
    const yearFontSize = rowH > 80 ? 16 : rowH > 60 ? 14 : 12
    const scoreFontSize = rowH > 80 ? 30 : rowH > 60 ? 24 : 18
    const logoMaxH = Math.max(20, rowH - 30)

    // Build title element: logo or text
    const titleElement = useLogo
      ? React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column' as const,
              flex: 1,
              paddingLeft: 16,
              paddingRight: 16,
              overflow: 'hidden',
              justifyContent: 'center',
            },
          },
          React.createElement('img', {
            src: logoSrc,
            style: {
              maxHeight: logoMaxH,
              maxWidth: 280,
              objectFit: 'contain' as const,
              objectPosition: 'left center',
            },
          }),
          year
            ? React.createElement(
                'span',
                {
                  style: {
                    fontFamily: 'DM Sans',
                    fontSize: yearFontSize,
                    color: 'rgba(245,240,232,0.5)',
                    marginTop: 4,
                  },
                },
                year
              )
            : null
        )
      : React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column' as const,
              flex: 1,
              paddingLeft: 16,
              paddingRight: 16,
              overflow: 'hidden',
            },
          },
          React.createElement(
            'span',
            {
              style: {
                fontFamily: 'Libre Baskerville',
                fontWeight: 700,
                fontSize: titleFontSize,
                color: IVORY,
                lineHeight: 1.2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap' as const,
              },
            },
            film.title
          ),
          year
            ? React.createElement(
                'span',
                {
                  style: {
                    fontFamily: 'DM Sans',
                    fontSize: yearFontSize,
                    color: 'rgba(245,240,232,0.5)',
                    marginTop: 2,
                  },
                },
                year
              )
            : null
        )

    return React.createElement(
      'div',
      {
        key: film.id,
        style: {
          display: 'flex',
          alignItems: 'center',
          width: W,
          height: rowH,
          position: 'relative' as const,
          overflow: 'hidden',
          borderBottom: i < count - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
        },
      },
      // Backdrop image: full-width background
      backdropSrc
        ? React.createElement('img', {
            src: backdropSrc,
            style: {
              position: 'absolute' as const,
              top: 0,
              left: 0,
              width: W,
              height: rowH,
              objectFit: 'cover' as const,
              objectPosition: `center ${cropY}%`,
            },
          })
        : null,
      // Gradient overlay: 92% opacity left, 15% right
      React.createElement('div', {
        style: {
          position: 'absolute' as const,
          top: 0,
          left: 0,
          width: W,
          height: rowH,
          background: `linear-gradient(to right, rgba(13,13,26,0.92) 0%, rgba(13,13,26,0.92) 35%, rgba(13,13,26,0.5) 65%, rgba(13,13,26,0.15) 100%)`,
        },
      }),
      // Content row
      React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            width: W,
            height: rowH,
            position: 'relative' as const,
            padding: '0 24px 0 20px',
            zIndex: 1,
          },
        },
        // Title (logo or font) + year
        titleElement,
        // Sparkline (pre-rendered PNG with intrinsic dimensions)
        sparkData
          ? React.createElement('img', {
              src: sparkData.uri,
              width: sparkData.w,
              height: sparkData.h,
              style: {
                position: 'absolute' as const,
                top: Math.round((rowH - sparkData.h) / 2),
                right: 24 + 56 + 10, // row padding + score width + gap
                width: sparkData.w,
                height: sparkData.h,
              },
            })
          : null,
        // Score (absolute positioned, right-aligned)
        React.createElement(
          'span',
          {
            style: {
              position: 'absolute' as const,
              top: Math.round((rowH - scoreFontSize * 1.2) / 2),
              right: 24,
              fontFamily: score != null ? 'Libre Baskerville' : 'DM Sans',
              fontWeight: score != null ? 700 : 400,
              fontSize: score != null ? scoreFontSize : scoreFontSize - 4,
              color: score != null ? GOLD : 'rgba(255,255,255,0.2)',
              width: 56,
              textAlign: 'right' as const,
            },
          },
          score != null ? score.toFixed(1) : '--'
        )
      )
    )
  })

  // ── Full poster element ──
  const element = React.createElement(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        width: W,
        height: totalH,
        backgroundColor: BG,
      },
    },
    // Header
    React.createElement(
      'div',
      {
        style: {
          display: 'flex',
          flexDirection: 'column' as const,
          alignItems: 'center',
          justifyContent: 'center',
          height: headerH,
          padding: '0 40px',
        },
      },
      React.createElement(
        'span',
        {
          style: {
            fontFamily: 'Libre Baskerville',
            fontWeight: 700,
            fontSize: isTall ? 48 : isSquareOrPortrait ? 42 : 36,
            color: IVORY,
            textAlign: 'center' as const,
          },
        },
        title
      ),
      subtitle
        ? React.createElement(
            'span',
            {
              style: {
                fontFamily: 'DM Sans',
                fontSize: isTall ? 22 : isSquareOrPortrait ? 18 : 16,
                color: 'rgba(245,240,232,0.5)',
                marginTop: isTall ? 12 : 6,
                textAlign: 'center' as const,
              },
            },
            subtitle
          )
        : null
    ),
    // Separator
    React.createElement('div', {
      style: {
        width: W - 80,
        height: 1,
        backgroundColor: 'rgba(200,169,81,0.2)',
        marginLeft: 40,
      },
    }),
    // Rows
    ...rows,
    // Separator
    React.createElement('div', {
      style: {
        width: W - 80,
        height: 1,
        backgroundColor: 'rgba(200,169,81,0.2)',
        marginLeft: 40,
      },
    }),
    // Footer
    React.createElement(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: footerH,
          gap: 16,
        },
      },
      React.createElement(
        'span',
        {
          style: {
            fontFamily: 'Libre Baskerville',
            fontWeight: 700,
            fontSize: isTall ? 24 : isSquareOrPortrait ? 20 : 16,
            color: GOLD,
          },
        },
        'Cinemagraphs'
      ),
      React.createElement(
        'span',
        {
          style: {
            fontFamily: 'DM Sans',
            fontSize: isTall ? 18 : isSquareOrPortrait ? 15 : 13,
            color: 'rgba(245,240,232,0.35)',
          },
        },
        'Movie reviews, visualized'
      )
    )
  )

  try {
    const svg = await satori(element, {
      width: W,
      height: totalH,
      fonts: [
        { name: 'Libre Baskerville', data: fonts.baskerville, style: 'normal' as const, weight: 400 },
        { name: 'Libre Baskerville', data: fonts.baskervilleBold, style: 'normal' as const, weight: 700 },
        { name: 'DM Sans', data: fonts.dmSans, style: 'normal' as const, weight: 400 },
      ],
    })

    const png = await sharp(Buffer.from(svg)).png().toBuffer()

    return new NextResponse(new Uint8Array(png), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=0, must-revalidate',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('OG list generation failed:', message)
    return Response.json({ error: `Failed to generate poster: ${message}` }, { status: 500 })
  }
}
