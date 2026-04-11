import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import satori, { type SatoriOptions } from 'satori'
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

interface SparklineResult {
  uri: string
  w: number
  h: number
  yMin: number
  yMax: number
  midScore: number
}

async function buildSparklinePng(
  dataPoints: SentimentDataPoint[],
  sw: number,
  sh: number
): Promise<SparklineResult | null> {
  if (dataPoints.length < 2) return null

  const paddingX = 6
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
  const midScore = (yMin + yMax) / 2

  const points = dataPoints.map((dp, i) => ({
    x: paddingX + (i / (dataPoints.length - 1)) * innerW,
    y: paddingY + innerH - ((dp.score - yMin) / yRange) * innerH,
    score: dp.score,
  }))

  const peakIdx = points.reduce((best, p, i) => (p.score > points[best].score ? i : best), 0)
  const lowIdx = points.reduce((best, p, i) => (p.score < points[best].score ? i : best), 0)

  const path = catmullRomPath(points)

  const axisColor = 'rgba(232,228,220,0.5)'
  const midColor = 'rgba(232,228,220,0.5)'

  // Midpoint dashed line
  const midY = paddingY + innerH - ((midScore - yMin) / yRange) * innerH

  // SVG with axis lines — labels rendered by satori instead
  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}" viewBox="0 0 ${sw} ${sh}">`,
    // Left y-axis line
    `<line x1="${paddingX}" y1="${paddingY}" x2="${paddingX}" y2="${paddingY + innerH}" stroke="${axisColor}" stroke-width="1"/>`,
    // Bottom x-axis line
    `<line x1="${paddingX}" y1="${paddingY + innerH}" x2="${paddingX + innerW}" y2="${paddingY + innerH}" stroke="${axisColor}" stroke-width="1"/>`,
    // Dashed midpoint line
    `<line x1="${paddingX}" y1="${midY.toFixed(1)}" x2="${paddingX + innerW}" y2="${midY.toFixed(1)}" stroke="${midColor}" stroke-width="1" stroke-dasharray="4 3"/>`,
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

  return {
    uri: `data:image/png;base64,${png.toString('base64')}`,
    w: sw,
    h: sh,
    yMin,
    yMax,
    midScore,
  }
}

// ── Image fetching (convert to base64 data URI for satori) ──

async function fetchImageAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.error('[og/list] Image fetch failed:', { url, status: res.status })
      return null
    }
    const contentType = res.headers.get('content-type') || 'image/jpeg'

    // Reject non-image responses (TMDB can return HTML error pages)
    if (!contentType.startsWith('image/')) {
      console.error('[og/list] Non-image content-type, skipping:', { url, contentType })
      return null
    }

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
          return null
        }
      }
      const base64 = Buffer.from(svg).toString('base64')
      return `data:image/svg+xml;base64,${base64}`
    }

    const base64 = Buffer.from(buf).toString('base64')
    return `data:${contentType};base64,${base64}`
  } catch (err) {
    console.error('[og/list] Image fetch error:', { url, error: String(err) })
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
  const rawFilms = url.searchParams.get('films') || ''
  const filmIds = rawFilms.split(',').map((s) => s.trim()).filter(Boolean)
  const title = (url.searchParams.get('title') || 'Top Films').normalize('NFC')
  const subtitle = (url.searchParams.get('subtitle') || '').normalize('NFC')
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
      posterUrl: true,
      runtime: true,
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
      // Backdrop image (full-width row background), fall back to poster
      const bgUrl = film.backdropUrl
        ? `https://image.tmdb.org/t/p/w780${film.backdropUrl}`
        : film.posterUrl
          ? `https://image.tmdb.org/t/p/w780${film.posterUrl}`
          : null
      if (bgUrl) {
        tasks.push(
          fetchImageAsDataUri(bgUrl).then((uri) => {
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

  // Log image fetch results
  ordered.forEach((film) => {
    console.error('[og/list] Image cache:', {
      filmId: film.id,
      filmTitle: film.title,
      hasBackdrop: !!backdropCache.get(film.id),
      hasLogo: !!logoCache.get(film.id),
      display: displayMap.get(film.id),
    })
  })

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

  // Exact pixel layout: title far left, sparkline+score far right
  const titleStartX = 40
  const titleZoneW = 350
  const sparkStartX = 725
  const sparkZoneW = 280
  const scoreStartX = 1010
  const scoreZoneW = 60

  // Pre-render sparklines at exact display size
  const sparklineCache = new Map<string, SparklineResult>()
  const sparkW = sparkZoneW
  const sparkH = Math.round(rowH * 0.5)
  await Promise.all(
    ordered.map(async (film) => {
      const raw = film.sentimentGraph?.dataPoints
      console.error('[og/list] Film sparkline debug:', {
        filmId: film.id,
        filmTitle: film.title,
        hasSentimentGraph: !!film.sentimentGraph,
        typeofDataPoints: typeof raw,
        isArray: Array.isArray(raw),
        dataPointsPreview: JSON.stringify(raw)?.substring(0, 200),
      })
      const dataPoints = (Array.isArray(raw) ? raw : []) as unknown as SentimentDataPoint[]
      if (dataPoints.length >= 2) {
        const result = await buildSparklinePng(dataPoints, sparkW, sparkH)
        if (result) sparklineCache.set(film.id, result)
      }
    })
  )

  // ── Build rows ──
  // Set of film IDs forced to font display (populated on satori failures)
  const forceFont = new Set<string>()

  function buildRows() {
    return ordered.map((film, i) => buildRow(film, i))
  }

  function buildRow(film: typeof ordered[number], i: number) {
    const filmTitle = String(film.title || '').normalize('NFC')
    const year = film.releaseDate ? new Date(film.releaseDate).getFullYear().toString() : ''
    const score = film.sentimentGraph?.overallScore ?? null
    const backdropSrc = backdropCache.get(film.id) ?? null
    const cropY = cropMap.get(film.id) ?? 30
    const logoSrc = logoCache.get(film.id) ?? null
    const useLogo = !forceFont.has(film.id) && displayMap.get(film.id) === 'logo' && logoSrc != null
    const sparkData = sparklineCache.get(film.id) ?? null
    const runtimeMin = film.runtime ?? null
    const runtimeLabel = runtimeMin
      ? `${Math.floor(runtimeMin / 60)}h ${runtimeMin % 60}m`
      : null

    const titleFontSize = rowH > 80 ? 22 : rowH > 60 ? 18 : 14
    const yearFontSize = rowH > 80 ? 16 : rowH > 60 ? 14 : 12
    const scoreFontSize = rowH > 80 ? 30 : rowH > 60 ? 24 : 18
    const logoMaxH = Math.round(Math.max(16, (rowH - 30) * 0.75))

    // Build title element: logo or text — absolutely positioned in left zone
    const titleElement = useLogo
      ? React.createElement(
          'div',
          {
            style: {
              position: 'absolute' as const,
              left: titleStartX,
              top: 0,
              width: titleZoneW,
              height: rowH,
              display: 'flex',
              flexDirection: 'column' as const,
              overflow: 'hidden',
              justifyContent: 'center',
            },
          },
          React.createElement('img', {
            src: logoSrc,
            style: {
              maxHeight: logoMaxH,
              maxWidth: Math.round((titleZoneW - 16) * 0.8),
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
              position: 'absolute' as const,
              left: titleStartX,
              top: 0,
              width: titleZoneW,
              height: rowH,
              display: 'flex',
              flexDirection: 'column' as const,
              overflow: 'hidden',
              justifyContent: 'center',
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
            filmTitle
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
      // Backdrop image: full-width background (backdrop or poster fallback)
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
      // Gradient overlay
      React.createElement('div', {
        style: {
          position: 'absolute' as const,
          top: 0,
          left: 0,
          width: W,
          height: rowH,
          background: backdropSrc
            ? `linear-gradient(to right, rgba(13,13,26,0.92) 0%, rgba(13,13,26,0.92) 35%, rgba(13,13,26,0.5) 65%, rgba(13,13,26,0.15) 100%)`
            : `linear-gradient(to right, rgba(13,13,26,1) 0%, rgba(20,20,40,0.95) 50%, rgba(30,30,50,0.9) 100%)`,
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
            padding: 0,
            zIndex: 1,
          },
        },
        // Title (logo or font) + year
        titleElement,
        // Sparkline PNG + axis labels rendered by satori
        sparkData
          ? React.createElement(
              'div',
              {
                style: {
                  position: 'absolute' as const,
                  left: sparkStartX - 30,
                  top: Math.round((rowH - sparkData.h) / 2) - (runtimeLabel ? 0 : 0),
                  width: sparkData.w + 32,
                  height: sparkData.h + (runtimeLabel ? 14 : 0),
                  display: 'flex',
                  flexDirection: 'column' as const,
                },
              },
              // Main row: left labels + sparkline + right labels
              React.createElement(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'row' as const,
                    alignItems: 'stretch',
                    height: sparkData.h,
                  },
                },
                // Left y-axis labels
                React.createElement(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      flexDirection: 'column' as const,
                      justifyContent: 'space-between',
                      width: 28,
                    },
                  },
                  React.createElement('span', {
                    style: { fontFamily: 'DM Sans', fontSize: 11, color: 'rgba(245,240,232,0.7)', textAlign: 'right' as const },
                  }, sparkData.yMax.toFixed(1)),
                  React.createElement('span', {
                    style: { fontFamily: 'DM Sans', fontSize: 11, color: 'rgba(245,240,232,0.7)', textAlign: 'right' as const },
                  }, sparkData.midScore.toFixed(1)),
                  React.createElement('span', {
                    style: { fontFamily: 'DM Sans', fontSize: 11, color: 'rgba(245,240,232,0.7)', textAlign: 'right' as const },
                  }, sparkData.yMin.toFixed(1))
                ),
                // Sparkline image
                React.createElement('img', {
                  src: sparkData.uri,
                  width: sparkData.w,
                  height: sparkData.h,
                  style: {
                    width: sparkData.w,
                    height: sparkData.h,
                    marginLeft: 2,
                  },
                })
              ),
              // X-axis runtime labels row
              runtimeLabel
                ? React.createElement(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        flexDirection: 'row' as const,
                        justifyContent: 'space-between',
                        marginLeft: 30,
                        marginRight: 30,
                        marginTop: 1,
                      },
                    },
                    React.createElement('span', {
                      style: { fontFamily: 'DM Sans', fontSize: 11, color: 'rgba(245,240,232,0.7)' },
                    }, '0m'),
                    React.createElement('span', {
                      style: { fontFamily: 'DM Sans', fontSize: 11, color: 'rgba(245,240,232,0.7)' },
                    }, runtimeLabel)
                  )
                : null
            )
          : null,
        // Score — left: 940px, width: 120px, right-aligned
        React.createElement(
          'span',
          {
            style: {
              position: 'absolute' as const,
              left: scoreStartX,
              top: Math.round((rowH - scoreFontSize * 1.2) / 2),
              width: scoreZoneW,
              fontFamily: score != null ? 'Libre Baskerville' : 'DM Sans',
              fontWeight: score != null ? 700 : 400,
              fontSize: score != null ? scoreFontSize : scoreFontSize - 4,
              color: score != null ? GOLD : 'rgba(255,255,255,0.2)',
              textAlign: 'right' as const,
              paddingRight: 10,
            },
          },
          score != null ? score.toFixed(1) : '--'
        )
      )
    )
  }

  let rows = buildRows()

  // ── Full poster element ──
  // ── Shared chrome (header, separators, footer) ──
  const headerEl = React.createElement(
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
  )
  const separatorEl = React.createElement('div', {
    style: {
      width: W - 80,
      height: 1,
      backgroundColor: 'rgba(200,169,81,0.2)',
      marginLeft: 40,
    },
  })
  const footerEl = React.createElement(
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

  function buildElement(currentRows: React.ReactElement[]) {
    return React.createElement(
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
      headerEl,
      separatorEl,
      ...currentRows,
      separatorEl,
      footerEl,
    )
  }

  const satoriOpts: SatoriOptions = {
    width: W,
    height: totalH,
    fonts: [
      { name: 'Libre Baskerville', data: fonts.baskerville, style: 'normal' as const, weight: 400 },
      { name: 'Libre Baskerville', data: fonts.baskervilleBold, style: 'normal' as const, weight: 700 },
      { name: 'DM Sans', data: fonts.dmSans, style: 'normal' as const, weight: 400 },
    ],
  }

  // Test each row individually — if a logo crashes satori, fall back to font
  for (let i = 0; i < rows.length; i++) {
    try {
      const testEl = React.createElement('div', { style: { display: 'flex', width: W, height: 100 } }, rows[i])
      await satori(testEl, { width: satoriOpts.width, height: 100, fonts: satoriOpts.fonts })
    } catch (rowErr) {
      const film = ordered[i]
      console.error(`[og/list] Row ${i} ("${film.title}") crashed satori, falling back to font display`, {
        error: rowErr instanceof Error ? rowErr.message : String(rowErr),
      })
      forceFont.add(film.id)
    }
  }

  // Rebuild rows with font fallbacks if any logos crashed
  if (forceFont.size > 0) {
    rows = buildRows()
  }

  try {
    const svg = await satori(buildElement(rows), satoriOpts)

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
