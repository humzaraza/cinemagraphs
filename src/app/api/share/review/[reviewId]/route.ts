import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import satori from 'satori'
import sharp from 'sharp'
import React from 'react'

export const dynamic = 'force-dynamic'

const W = 1080
const H = 1920
const GOLD = '#c8a96e'
const DARK = '#0f1117'
const GRAPH_BG = '#181b24'
const IVORY = '#f5f0e8'

// Font cache
const fontCache: Record<string, ArrayBuffer> = {}

async function loadFonts(): Promise<{ playfair: ArrayBuffer; dmSans: ArrayBuffer; dmSansItalic: ArrayBuffer }> {
  if (fontCache.playfair && fontCache.dmSans && fontCache.dmSansItalic) {
    return { playfair: fontCache.playfair, dmSans: fontCache.dmSans, dmSansItalic: fontCache.dmSansItalic }
  }

  const [playfairRes, dmSansRes, dmSansItalicRes] = await Promise.all([
    fetch('https://fonts.gstatic.com/s/playfairdisplay/v40/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKeiukDQ.ttf'),
    fetch('https://fonts.gstatic.com/s/dmsans/v17/rP2rp2ywxg089UriCZaSExd86J3t9jz86Mvy4qCRAL19DksVat-JDW3z.ttf'),
    fetch('https://fonts.gstatic.com/s/dmsans/v17/rP2tp2ywxg089UriI5-g4vlH9VoD8CmcqZG40F9JadbnoEwAopxhTg.ttf'),
  ])

  fontCache.playfair = await playfairRes.arrayBuffer()
  fontCache.dmSans = await dmSansRes.arrayBuffer()
  fontCache.dmSansItalic = await dmSansItalicRes.arrayBuffer()

  return { playfair: fontCache.playfair, dmSans: fontCache.dmSans, dmSansItalic: fontCache.dmSansItalic }
}

function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const truncated = text.slice(0, maxLen)
  const lastSpace = truncated.lastIndexOf(' ')
  if (lastSpace > maxLen * 0.5) {
    return truncated.slice(0, lastSpace) + '...'
  }
  return truncated + '...'
}

function buildGoldPath(dataPoints: { score: number }[], w: number, h: number, x: number, y: number): string {
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
  const linePath = buildGoldPath(dataPoints, w, h, x, y)
  return `${linePath} L${(x + w).toFixed(1)},${(y + h).toFixed(1)} L${x.toFixed(1)},${(y + h).toFixed(1)} Z`
}

// Y-axis label positions: 10, 7, 5, 1
function yForScore(score: number, h: number, y: number): number {
  return y + h - ((score - 1) / 9) * h
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
    const styleParam = request.nextUrl.searchParams.get('style')
    const style = styleParam === 'frosted-story' ? 'frosted-story' : 'cinematic-card'

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

    const filmTitle = truncateAtWord(review.film.title, 50)
    const year = review.film.releaseDate
      ? new Date(review.film.releaseDate).getFullYear().toString()
      : ''
    const director = review.film.director || ''
    const score = review.overallRating
    const quoteText = review.combinedText ? truncateAtWord(review.combinedText, 140) : ''
    const username = review.user.name || review.user.email.split('@')[0]
    const dataPoints = (review.film.sentimentGraph?.dataPoints as { label: string; score: number }[]) || []
    const posterUrl = review.film.posterUrl
      ? `https://image.tmdb.org/t/p/w780${review.film.posterUrl}`
      : null

    const fonts = await loadFonts()
    let element: React.ReactElement

    // Shared graph dimensions
    const graphInnerW = W - 200
    const graphInnerH = 320

    // Build the graph panel element: a wrapper with Y-axis labels (as divs) + SVG chart
    function buildGraphPanel(gw: number, gh: number): React.ReactElement {
      const goldPath = buildGoldPath(dataPoints, gw, gh, 0, 0)
      const fillPath = buildFillPath(dataPoints, gw, gh, 0, 0)

      const svgChildren: React.ReactElement[] = []

      // Dashed midline at score 5
      const midY = yForScore(5, gh, 0)
      svgChildren.push(
        React.createElement('line', {
          key: 'mid',
          x1: 0, y1: midY, x2: gw, y2: midY,
          stroke: 'rgba(255,255,255,0.12)',
          strokeWidth: 1,
          strokeDasharray: '8 6',
        })
      )

      // Fill area under curve
      if (fillPath) {
        svgChildren.push(
          React.createElement('path', { key: 'fill', d: fillPath, fill: `${GOLD}18` })
        )
      }

      // Gold line
      if (goldPath) {
        svgChildren.push(
          React.createElement('path', { key: 'line', d: goldPath, fill: 'none', stroke: GOLD, strokeWidth: 3.5 })
        )
      }

      // Dots at each data point
      dataPoints.forEach((dp, i) => {
        const px = (i / (dataPoints.length - 1)) * gw
        const py = gh - ((dp.score - 1) / 9) * gh
        svgChildren.push(
          React.createElement('circle', { key: `dot-${i}`, cx: px, cy: py, r: 4, fill: GOLD })
        )
      })

      // Y-axis labels as positioned divs
      const yLabels = [10, 7, 5, 1]
      const labelElements = yLabels.map((val) => {
        const topPercent = ((10 - val) / 9) * 100
        return React.createElement(
          'div',
          {
            key: `y-${val}`,
            style: {
              position: 'absolute',
              left: 0,
              top: `${topPercent}%`,
              transform: 'translateY(-50%)',
              fontSize: 18,
              color: 'rgba(255,255,255,0.35)',
              fontFamily: 'DM Sans',
              width: 40,
              textAlign: 'right',
            },
          },
          val.toString()
        )
      })

      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'stretch',
            width: '100%',
            height: '100%',
            position: 'relative',
          },
        },
        // Y-axis label column
        React.createElement(
          'div',
          {
            style: {
              width: 50,
              position: 'relative',
              flexShrink: 0,
            },
          },
          ...labelElements
        ),
        // SVG chart
        React.createElement(
          'svg',
          { width: gw, height: gh, viewBox: `0 0 ${gw} ${gh}`, style: { flex: 1 } },
          ...svgChildren
        )
      )
    }

    if (style === 'cinematic-card') {
      // Style A — Cinematic Card
      const posterH = Math.floor(H * 0.25)
      const titleRowY = posterH + 50
      const metaY = titleRowY + 80
      const graphLabelY = metaY + 60
      const graphY = graphLabelY + 50
      const graphBoxH = graphInnerH + 60
      const quoteY = graphY + graphBoxH + 40

      element = React.createElement(
        'div',
        {
          style: {
            width: W,
            height: H,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: DARK,
            position: 'relative',
          },
        },
        // Poster strip at top
        posterUrl
          ? React.createElement('img', {
              src: posterUrl,
              style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: W,
                height: posterH,
                objectFit: 'cover',
              },
            })
          : null,
        // Poster fade to dark
        React.createElement('div', {
          style: {
            position: 'absolute',
            top: posterH - 120,
            left: 0,
            width: W,
            height: 120,
            background: `linear-gradient(to bottom, transparent, ${DARK})`,
          },
        }),
        // Title row: film title left, score right
        React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              top: titleRowY,
              left: 60,
              right: 60,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
            },
          },
          React.createElement(
            'div',
            {
              style: {
                fontSize: 52,
                fontWeight: 700,
                color: IVORY,
                fontFamily: 'Playfair Display',
                lineHeight: 1.15,
                maxWidth: W - 320,
              },
            },
            filmTitle
          ),
          React.createElement(
            'div',
            {
              style: {
                fontSize: 96,
                fontWeight: 700,
                color: GOLD,
                fontFamily: 'Playfair Display',
                lineHeight: 1,
              },
            },
            score.toFixed(1)
          )
        ),
        // Year + Director
        (year || director)
          ? React.createElement(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: metaY,
                  left: 60,
                  fontSize: 26,
                  color: 'rgba(255,255,255,0.45)',
                  fontFamily: 'DM Sans',
                },
              },
              [year, director].filter(Boolean).join('  \u00b7  ')
            )
          : null,
        // "SENTIMENT ARC" label
        dataPoints.length >= 2
          ? React.createElement(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: graphLabelY,
                  left: 60,
                  fontSize: 18,
                  fontWeight: 700,
                  color: GOLD,
                  letterSpacing: 4,
                  fontFamily: 'DM Sans',
                },
              },
              'SENTIMENT ARC'
            )
          : null,
        // Graph panel
        dataPoints.length >= 2
          ? React.createElement(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: graphY,
                  left: 50,
                  right: 50,
                  height: graphBoxH,
                  backgroundColor: GRAPH_BG,
                  borderRadius: 16,
                  border: '1px solid rgba(200,169,110,0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '30px 20px',
                },
              },
              buildGraphPanel(graphInnerW, graphInnerH)
            )
          : null,
        // Quote
        quoteText
          ? React.createElement(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: quoteY,
                  left: 60,
                  right: 60,
                  fontSize: 28,
                  fontStyle: 'italic',
                  color: 'rgba(255,255,255,0.55)',
                  lineHeight: 1.5,
                  fontFamily: 'DM Sans',
                },
              },
              `\u201c${quoteText}\u201d`
            )
          : null,
        // Attribution
        quoteText
          ? React.createElement(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: quoteY + (quoteText.length > 80 ? 130 : 80),
                  right: 60,
                  fontSize: 24,
                  color: GOLD,
                  fontFamily: 'DM Sans',
                },
              },
              `\u2014 ${username}`
            )
          : null,
        // Footer bar
        React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              bottom: 50,
              left: 60,
              right: 60,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            },
          },
          React.createElement(
            'div',
            {
              style: {
                fontSize: 30,
                fontWeight: 700,
                color: GOLD,
                fontFamily: 'Playfair Display',
              },
            },
            'Cinemagraphs'
          ),
          React.createElement(
            'div',
            {
              style: {
                fontSize: 22,
                color: 'rgba(255,255,255,0.35)',
                fontFamily: 'DM Sans',
              },
            },
            'cinemagraphs.ca'
          )
        ),
        // Gold accent line at very bottom
        React.createElement('div', {
          style: {
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: W,
            height: 4,
            backgroundColor: GOLD,
          },
        })
      )
    } else {
      // Style B — Frosted Story
      element = React.createElement(
        'div',
        {
          style: {
            width: W,
            height: H,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: DARK,
            position: 'relative',
          },
        },
        // Full-bleed poster
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
        // Heavy dark gradient overlay
        React.createElement('div', {
          style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: W,
            height: H,
            background: `linear-gradient(to bottom, rgba(15,17,23,0.15) 0%, rgba(15,17,23,0.5) 30%, rgba(15,17,23,0.92) 50%, rgba(15,17,23,0.98) 65%)`,
          },
        }),
        // Top bar: "CINEMAGRAPHS" left, score right
        React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              top: 55,
              left: 60,
              right: 60,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
            },
          },
          React.createElement(
            'div',
            {
              style: {
                fontSize: 18,
                fontWeight: 700,
                color: GOLD,
                letterSpacing: 5,
                fontFamily: 'DM Sans',
              },
            },
            'CINEMAGRAPHS'
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
              {
                style: {
                  fontSize: 96,
                  fontWeight: 700,
                  color: GOLD,
                  fontFamily: 'Playfair Display',
                  lineHeight: 1,
                },
              },
              score.toFixed(1)
            )
          )
        ),
        // Film title (middle area)
        React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              top: 520,
              left: 60,
              right: 60,
              display: 'flex',
              flexDirection: 'column',
            },
          },
          React.createElement(
            'div',
            {
              style: {
                fontSize: 56,
                fontWeight: 700,
                color: IVORY,
                fontFamily: 'Playfair Display',
                lineHeight: 1.15,
              },
            },
            filmTitle
          ),
          (year || director)
            ? React.createElement(
                'div',
                {
                  style: {
                    fontSize: 26,
                    color: 'rgba(255,255,255,0.45)',
                    marginTop: 16,
                    fontFamily: 'DM Sans',
                  },
                },
                [year, director].filter(Boolean).join('  \u00b7  ')
              )
            : null
        ),
        // Graph panel with semi-transparent dark bg
        dataPoints.length >= 2
          ? React.createElement(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: 780,
                  left: 50,
                  right: 50,
                  height: graphInnerH + 60,
                  backgroundColor: 'rgba(24,27,36,0.85)',
                  borderRadius: 16,
                  border: `1px solid ${GOLD}30`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '30px 20px',
                },
              },
              buildGraphPanel(graphInnerW, graphInnerH)
            )
          : null,
        // Quote card with gold left border
        quoteText
          ? React.createElement(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: dataPoints.length >= 2 ? 1200 : 820,
                  left: 60,
                  right: 60,
                  display: 'flex',
                  flexDirection: 'row',
                },
              },
              // Gold left border accent
              React.createElement('div', {
                style: {
                  width: 4,
                  backgroundColor: GOLD,
                  borderRadius: 2,
                  marginRight: 24,
                  flexShrink: 0,
                },
              }),
              React.createElement(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    flex: 1,
                  },
                },
                React.createElement(
                  'div',
                  {
                    style: {
                      fontSize: 28,
                      fontStyle: 'italic',
                      color: 'rgba(255,255,255,0.6)',
                      lineHeight: 1.5,
                      fontFamily: 'DM Sans',
                    },
                  },
                  `\u201c${quoteText}\u201d`
                ),
                React.createElement(
                  'div',
                  {
                    style: {
                      fontSize: 24,
                      color: GOLD,
                      marginTop: 16,
                      fontFamily: 'DM Sans',
                    },
                  },
                  `\u2014 ${username}`
                )
              )
            )
          : null,
        // Bottom branding
        React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              bottom: 55,
              left: 0,
              width: W,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            },
          },
          React.createElement(
            'div',
            {
              style: {
                fontSize: 22,
                color: 'rgba(255,255,255,0.35)',
                fontFamily: 'DM Sans',
              },
            },
            'cinemagraphs.ca'
          )
        ),
        // Gold accent line at very bottom
        React.createElement('div', {
          style: {
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: W,
            height: 4,
            backgroundColor: GOLD,
          },
        })
      )
    }

    const svg = await satori(element, {
      width: W,
      height: H,
      fonts: [
        { name: 'Playfair Display', data: fonts.playfair, style: 'normal', weight: 700 },
        { name: 'DM Sans', data: fonts.dmSans, style: 'normal', weight: 400 },
        { name: 'DM Sans', data: fonts.dmSansItalic, style: 'italic', weight: 400 },
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
