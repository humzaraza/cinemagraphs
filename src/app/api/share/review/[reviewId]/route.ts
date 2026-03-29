import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import satori from 'satori'
import sharp from 'sharp'
import React from 'react'
import { readFile } from 'fs/promises'
import { join } from 'path'

export const dynamic = 'force-dynamic'

const W = 1080
const H = 1920

let fontData: ArrayBuffer | null = null
async function loadFont(): Promise<ArrayBuffer> {
  if (fontData) return fontData
  // Try to load from @vercel/og's bundled font, fall back to system
  try {
    const fontPath = join(process.cwd(), 'node_modules/@vercel/og/dist/Geist-Regular.ttf')
    const buf = await readFile(fontPath)
    fontData = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  } catch {
    // Fallback: fetch a Google Font
    const res = await fetch('https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff')
    fontData = await res.arrayBuffer()
  }
  return fontData
}

function ratingColor(score: number): string {
  return score >= 7 ? '#C8A951' : '#ef4444'
}

function buildSvgPath(dataPoints: { score: number }[], w: number, h: number, x: number, y: number): string {
  if (dataPoints.length < 2) return ''
  return dataPoints
    .map((dp, i) => {
      const px = x + (i / (dataPoints.length - 1)) * w
      const py = y + h - ((dp.score - 1) / 9) * h
      return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`
    })
    .join(' ')
}

function buildFillPath(dataPoints: { score: number }[], w: number, h: number, x: number, y: number): string {
  if (dataPoints.length < 2) return ''
  const linePath = buildSvgPath(dataPoints, w, h, x, y)
  return `${linePath} L${(x + w).toFixed(1)},${(y + h).toFixed(1)} L${x.toFixed(1)},${(y + h).toFixed(1)} Z`
}

function buildUserPath(
  dataPoints: { label: string; score: number }[],
  beatRatings: Record<string, number>,
  w: number, h: number, x: number, y: number
): string {
  const matched = dataPoints
    .map((dp, i) => {
      const rating = beatRatings[dp.label]
      if (rating === undefined) return null
      const px = x + (i / (dataPoints.length - 1)) * w
      const py = y + h - ((rating - 1) / 9) * h
      return { px, py }
    })
    .filter(Boolean) as { px: number; py: number }[]

  if (matched.length < 2) return ''
  return matched.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(' ')
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { reviewId } = await params
    const style = request.nextUrl.searchParams.get('style') === 'minimal' ? 'minimal' : 'full'

    const review = await prisma.userReview.findUnique({
      where: { id: reviewId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        film: {
          select: {
            title: true,
            posterUrl: true,
            releaseDate: true,
            director: true,
            sentimentGraph: { select: { dataPoints: true } },
          },
        },
      },
    })

    if (!review) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 })
    }

    if (review.userId !== session.user.id) {
      return NextResponse.json({ error: 'You can only share your own reviews' }, { status: 403 })
    }

    const rawTitle = review.film.title
    const filmTitle = rawTitle.length > 60 ? rawTitle.slice(0, 57) + '...' : rawTitle
    const year = review.film.releaseDate
      ? new Date(review.film.releaseDate).getFullYear().toString()
      : ''
    const director = review.film.director || ''
    const score = review.overallRating
    const quoteText = review.combinedText?.slice(0, 120) || ''
    const username = review.user.name || review.user.email.split('@')[0]
    const dataPoints = (review.film.sentimentGraph?.dataPoints as { label: string; score: number }[]) || []
    const beatRatings = review.beatRatings as Record<string, number> | null
    const posterUrl = review.film.posterUrl
      ? `https://image.tmdb.org/t/p/w500${review.film.posterUrl}`
      : null

    // Graph dimensions
    const gx = 60, gw = W - 120, gh = 160

    const font = await loadFont()
    let element: React.ReactElement

    if (style === 'full') {
      const goldPath = buildSvgPath(dataPoints, gw, gh, gx, 0)
      const fillPath = buildFillPath(dataPoints, gw, gh, gx, 0)
      const userPath = beatRatings ? buildUserPath(dataPoints, beatRatings, gw, gh, gx, 0) : ''

      element = React.createElement(
        'div',
        {
          style: {
            width: W,
            height: H,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            backgroundColor: '#0D0D1A',
            fontFamily: 'Geist, sans-serif',
            position: 'relative',
          },
        },
        // Poster background top
        posterUrl
          ? React.createElement('img', {
              src: posterUrl,
              style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: W,
                height: Math.floor(H * 0.58),
                objectFit: 'cover',
              },
            })
          : null,
        // Gradient fade
        React.createElement('div', {
          style: {
            position: 'absolute',
            top: Math.floor(H * 0.58) - 300,
            left: 0,
            width: W,
            height: 300,
            background: 'linear-gradient(to bottom, rgba(13,13,26,0), #0D0D1A)',
          },
        }),
        // Dark below poster
        React.createElement('div', {
          style: {
            position: 'absolute',
            top: Math.floor(H * 0.58),
            left: 0,
            width: W,
            height: H - Math.floor(H * 0.58),
            backgroundColor: '#0D0D1A',
          },
        }),
        // Content area
        React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              top: Math.floor(H * 0.58) + 20,
              left: 0,
              width: W,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '0 60px',
            },
          },
          // Rating
          React.createElement(
            'div',
            {
              style: {
                fontSize: 120,
                fontWeight: 'bold',
                color: ratingColor(score),
                lineHeight: 1,
              },
            },
            score.toFixed(1)
          ),
          // Film title
          React.createElement(
            'div',
            {
              style: {
                fontSize: 48,
                fontWeight: 'bold',
                color: '#F0E6D3',
                textAlign: 'center',
                marginTop: 20,
                lineHeight: 1.2,
                maxWidth: W - 120,
              },
            },
            filmTitle
          ),
          // Year / Director
          (year || director)
            ? React.createElement(
                'div',
                {
                  style: {
                    fontSize: 28,
                    color: 'rgba(255,255,255,0.4)',
                    marginTop: 20,
                  },
                },
                [year, director].filter(Boolean).join(' \u00b7 ')
              )
            : null,
          // Sentiment graph
          dataPoints.length >= 2
            ? React.createElement(
                'div',
                {
                  style: {
                    width: gw + 40,
                    height: gh + 20,
                    marginTop: 30,
                    borderRadius: 12,
                    backgroundColor: 'rgba(255,255,255,0.04)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '10px 20px',
                  },
                },
                React.createElement(
                  'svg',
                  { width: gw, height: gh, viewBox: `0 0 ${gw} ${gh}` },
                  React.createElement('path', {
                    d: fillPath,
                    fill: 'rgba(200,169,81,0.15)',
                  }),
                  React.createElement('path', {
                    d: goldPath,
                    fill: 'none',
                    stroke: '#C8A951',
                    strokeWidth: 3,
                  }),
                  userPath
                    ? React.createElement('path', {
                        d: userPath,
                        fill: 'none',
                        stroke: '#2DD4A8',
                        strokeWidth: 2,
                        strokeDasharray: '8 6',
                      })
                    : null
                )
              )
            : null,
          // Quote
          quoteText
            ? React.createElement(
                'div',
                {
                  style: {
                    fontSize: 30,
                    fontStyle: 'italic',
                    color: 'rgba(255,255,255,0.55)',
                    textAlign: 'center',
                    marginTop: 30,
                    maxWidth: W - 120,
                    lineHeight: 1.4,
                  },
                },
                `\u201c${quoteText}${quoteText.length >= 120 ? '...' : ''}\u201d`
              )
            : null,
          // Attribution
          quoteText
            ? React.createElement(
                'div',
                {
                  style: {
                    fontSize: 26,
                    color: 'rgba(200,169,81,0.7)',
                    marginTop: 15,
                    alignSelf: 'flex-end',
                  },
                },
                `\u2014 ${username}`
              )
            : null
        ),
        // Branding at bottom
        React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              bottom: 40,
              left: 0,
              width: W,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            },
          },
          React.createElement(
            'div',
            { style: { fontSize: 36, fontWeight: 'bold', color: '#C8A951' } },
            'Cinemagraphs'
          ),
          React.createElement(
            'div',
            { style: { fontSize: 22, color: 'rgba(255,255,255,0.35)', marginTop: 4 } },
            'cinemagraphs.ca'
          )
        ),
        // Gold bar at bottom
        React.createElement('div', {
          style: {
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: W,
            height: 6,
            backgroundColor: '#C8A951',
          },
        })
      )
    } else {
      // Minimal style
      const graphH2 = 180
      const goldPath = buildSvgPath(dataPoints, gw, graphH2, gx, 0)
      const fillPath = buildFillPath(dataPoints, gw, graphH2, gx, 0)
      const userPath = beatRatings ? buildUserPath(dataPoints, beatRatings, gw, graphH2, gx, 0) : ''

      element = React.createElement(
        'div',
        {
          style: {
            width: W,
            height: H,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#0D0D1A',
            fontFamily: 'Geist, sans-serif',
            position: 'relative',
          },
        },
        // Full poster background
        posterUrl
          ? React.createElement('img', {
              src: posterUrl,
              style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: W,
                height: H,
                objectFit: 'cover',
              },
            })
          : null,
        // Dark overlay
        React.createElement('div', {
          style: {
            position: 'absolute',
            top: Math.floor(H * 0.35),
            left: 0,
            width: W,
            height: H - Math.floor(H * 0.35),
            background: 'linear-gradient(to bottom, rgba(13,13,26,0), rgba(13,13,26,0.92) 40%)',
          },
        }),
        // Score top right
        React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              top: 50,
              right: 60,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
            },
          },
          React.createElement(
            'div',
            { style: { fontSize: 100, fontWeight: 'bold', color: ratingColor(score), lineHeight: 1 } },
            score.toFixed(1)
          ),
          React.createElement(
            'div',
            { style: { fontSize: 18, color: 'rgba(200,169,81,0.6)', letterSpacing: 3, marginTop: 8 } },
            'CINEMAGRAPHS SCORE'
          )
        ),
        // Graph
        dataPoints.length >= 2
          ? React.createElement(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: H - 550,
                  left: 0,
                  width: W,
                  display: 'flex',
                  justifyContent: 'center',
                },
              },
              React.createElement(
                'svg',
                { width: gw, height: graphH2, viewBox: `0 0 ${gw} ${graphH2}` },
                React.createElement('path', { d: fillPath, fill: 'rgba(200,169,81,0.15)' }),
                React.createElement('path', { d: goldPath, fill: 'none', stroke: '#C8A951', strokeWidth: 3 }),
                userPath
                  ? React.createElement('path', { d: userPath, fill: 'none', stroke: '#2DD4A8', strokeWidth: 2, strokeDasharray: '8 6' })
                  : null
              )
            )
          : null,
        // Bottom content
        React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              bottom: 80,
              left: 60,
              right: 60,
              display: 'flex',
              flexDirection: 'column',
            },
          },
          // Quote
          quoteText
            ? React.createElement(
                'div',
                {
                  style: {
                    fontSize: 28,
                    fontStyle: 'italic',
                    color: 'rgba(255,255,255,0.55)',
                    lineHeight: 1.4,
                    marginBottom: 12,
                  },
                },
                `\u201c${quoteText}${quoteText.length >= 120 ? '...' : ''}\u201d`
              )
            : null,
          quoteText
            ? React.createElement(
                'div',
                { style: { fontSize: 24, color: 'rgba(200,169,81,0.7)', marginBottom: 30 } },
                `\u2014 ${username}`
              )
            : null,
          // Film title
          React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-end',
              },
            },
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', flex: 1 } },
              React.createElement(
                'div',
                {
                  style: {
                    fontSize: 44,
                    fontWeight: 'bold',
                    color: '#F0E6D3',
                    lineHeight: 1.2,
                    maxWidth: W - 360,
                  },
                },
                filmTitle
              ),
              year
                ? React.createElement(
                    'div',
                    { style: { fontSize: 26, color: 'rgba(255,255,255,0.4)', marginTop: 8 } },
                    year
                  )
                : null
            ),
            React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-end',
                },
              },
              React.createElement(
                'div',
                { style: { fontSize: 28, fontWeight: 'bold', color: '#C8A951' } },
                'Cinemagraphs'
              ),
              React.createElement(
                'div',
                { style: { fontSize: 18, color: 'rgba(255,255,255,0.35)', marginTop: 4 } },
                'cinemagraphs.ca'
              )
            )
          )
        ),
        // Gold bar
        React.createElement('div', {
          style: {
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: W,
            height: 6,
            backgroundColor: '#C8A951',
          },
        })
      )
    }

    // Use satori to render React element to SVG, then sharp to convert to PNG
    const svg = await satori(element, {
      width: W,
      height: H,
      fonts: [
        {
          name: 'Geist',
          data: font,
          style: 'normal',
          weight: 400,
        },
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
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Share image generation failed:', message, err)
    return NextResponse.json({ error: 'Failed to generate share image.', _debug: message }, { status: 500 })
  }
}
