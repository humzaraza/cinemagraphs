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

function buildSparkline(
  dataPoints: SentimentDataPoint[],
  sw: number,
  sh: number
): React.ReactElement {
  if (dataPoints.length < 2) {
    return React.createElement('svg', { width: sw, height: sh })
  }

  const paddingX = 18 // extra horizontal space for y-axis labels
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
  const labelStyle = {
    fontFamily: 'DM Sans',
    fontSize: 8,
    color: labelColor,
    position: 'absolute' as const,
    lineHeight: 1,
  }

  const children: React.ReactElement[] = [
    // Y-axis (left)
    React.createElement('line', {
      key: 'yaxis-l',
      x1: paddingX,
      y1: paddingY,
      x2: paddingX,
      y2: paddingY + innerH,
      stroke: axisColor,
      strokeWidth: 1,
    }),
    // Y-axis (right)
    React.createElement('line', {
      key: 'yaxis-r',
      x1: paddingX + innerW,
      y1: paddingY,
      x2: paddingX + innerW,
      y2: paddingY + innerH,
      stroke: axisColor,
      strokeWidth: 1,
    }),
    // X-axis (bottom)
    React.createElement('line', {
      key: 'xaxis',
      x1: paddingX,
      y1: paddingY + innerH,
      x2: paddingX + innerW,
      y2: paddingY + innerH,
      stroke: axisColor,
      strokeWidth: 1,
    }),
  ]

  // Y-axis labels as absolutely positioned divs (satori doesn't support SVG <text>)
  const labels: React.ReactElement[] = [
    // Left side labels (right-aligned to left axis)
    React.createElement('span', {
      key: 'lbl-l-max',
      style: { ...labelStyle, top: paddingY - 4, left: 0, width: paddingX - 3, textAlign: 'right' as const },
    }, String(yMax)),
    React.createElement('span', {
      key: 'lbl-l-min',
      style: { ...labelStyle, bottom: paddingY - 4, left: 0, width: paddingX - 3, textAlign: 'right' as const },
    }, String(yMin)),
    // Right side labels (left-aligned to right axis)
    React.createElement('span', {
      key: 'lbl-r-max',
      style: { ...labelStyle, top: paddingY - 4, right: 0, width: paddingX - 3, textAlign: 'left' as const },
    }, String(yMax)),
    React.createElement('span', {
      key: 'lbl-r-min',
      style: { ...labelStyle, bottom: paddingY - 4, right: 0, width: paddingX - 3, textAlign: 'left' as const },
    }, String(yMin)),
  ]

  // Dashed reference line at midpoint of the dynamic y-axis range
  const midScore = (yMin + yMax) / 2
  const midY = paddingY + innerH - ((midScore - yMin) / yRange) * innerH
  children.push(
    React.createElement('line', {
      key: 'neutral',
      x1: paddingX,
      y1: midY,
      x2: paddingX + innerW,
      y2: midY,
      stroke: neutralColor,
      strokeWidth: 1,
      strokeDasharray: '4 3',
    })
  )

  children.push(
    // Data line
    React.createElement('path', {
      key: 'line',
      d: path,
      fill: 'none',
      stroke: GOLD,
      strokeWidth: 2,
      strokeLinecap: 'round',
    }),
    // Peak dot (teal)
    React.createElement('circle', {
      key: 'peak',
      cx: points[peakIdx].x,
      cy: points[peakIdx].y,
      r: 3.5,
      fill: TEAL,
    })
  )

  // Low dot only if below 7.5
  if (points[lowIdx].score < 7.5) {
    children.push(
      React.createElement('circle', {
        key: 'low',
        cx: points[lowIdx].x,
        cy: points[lowIdx].y,
        r: 3.5,
        fill: RED,
      })
    )
  }

  const svg = React.createElement(
    'svg',
    {
      width: sw,
      height: sh,
      viewBox: `0 0 ${sw} ${sh}`,
      style: { display: 'flex' },
    },
    ...children
  )

  // Wrap SVG + label divs in a relative container
  return React.createElement(
    'div',
    {
      style: {
        position: 'relative' as const,
        width: sw,
        height: sh,
        display: 'flex',
      },
    },
    svg,
    ...labels
  )
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
  filmIds.forEach((id, i) => {
    displayMap.set(id, displays[i] === 'font' ? 'font' : 'logo')
    cropMap.set(id, crops[i] ? Math.max(0, Math.min(100, Number(crops[i]) || 30)) : 30)
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

  // Scale sparkline proportionally with row height
  const sparkW = isTall ? 280 : isSquareOrPortrait ? 250 : 220
  const sparkH = Math.max(24, rowH - 20)

  // ── Build rows ──
  const rows = ordered.map((film, i) => {
    const year = film.releaseDate ? new Date(film.releaseDate).getFullYear().toString() : ''
    const score = film.sentimentGraph?.overallScore ?? null
    const dataPoints = (film.sentimentGraph?.dataPoints as unknown as SentimentDataPoint[]) ?? []
    const backdropSrc = backdropCache.get(film.id) ?? null
    const cropY = cropMap.get(film.id) ?? 30
    const logoSrc = logoCache.get(film.id) ?? null
    const useLogo = displayMap.get(film.id) === 'logo' && logoSrc != null

    const sparkline =
      dataPoints.length >= 2 ? buildSparkline(dataPoints, sparkW, sparkH) : null

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
        // Sparkline
        sparkline
          ? React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                  marginLeft: 'auto' as const,
                  marginRight: 10,
                },
              },
              sparkline
            )
          : null,
        // Score
        score != null
          ? React.createElement(
              'span',
              {
                style: {
                  fontFamily: 'Libre Baskerville',
                  fontWeight: 700,
                  fontSize: scoreFontSize,
                  color: GOLD,
                  flexShrink: 0,
                  width: 56,
                  textAlign: 'right' as const,
                },
              },
              score.toFixed(1)
            )
          : React.createElement(
              'span',
              {
                style: {
                  fontFamily: 'DM Sans',
                  fontSize: scoreFontSize - 4,
                  color: 'rgba(255,255,255,0.2)',
                  flexShrink: 0,
                  width: 56,
                  textAlign: 'right' as const,
                },
              },
              '--'
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
