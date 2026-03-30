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

// Build user's sentiment data points from their beatRatings
function buildUserDataPoints(
  beatRatings: Record<string, number> | null,
  graphLabels: { label: string; score: number }[]
): { label: string; score: number }[] {
  if (!beatRatings || !graphLabels.length) return []
  return graphLabels
    .filter((dp) => beatRatings[dp.label] !== undefined)
    .map((dp) => ({ label: dp.label, score: beatRatings[dp.label] }))
}

function buildLinePath(points: { score: number }[], w: number, h: number): string {
  if (points.length < 2) return ''
  return points
    .map((dp, i) => {
      const px = (i / (points.length - 1)) * w
      const py = h - ((dp.score - 1) / 9) * h
      return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`
    })
    .join(' ')
}

function buildFillPath(points: { score: number }[], w: number, h: number): string {
  if (points.length < 2) return ''
  const line = buildLinePath(points, w, h)
  return `${line} L${w.toFixed(1)},${h.toFixed(1)} L0,${h.toFixed(1)} Z`
}

function yForScore(score: number, h: number): number {
  return h - ((score - 1) / 9) * h
}

// Build graph panel with Y-axis labels + SVG chart (for Cinematic Overlay — with container)
function buildGraphPanel(
  points: { score: number }[],
  gw: number,
  gh: number
): React.ReactElement {
  const linePath = buildLinePath(points, gw, gh)
  const fillPath = buildFillPath(points, gw, gh)
  const midY = yForScore(5, gh)

  const svgChildren: React.ReactElement[] = []

  // Dashed midline at score 5
  svgChildren.push(
    React.createElement('line', {
      key: 'mid', x1: 0, y1: midY, x2: gw, y2: midY,
      stroke: 'rgba(255,255,255,0.12)', strokeWidth: 1, strokeDasharray: '8 6',
    })
  )

  // Fill under curve with very subtle gold tint
  if (fillPath) {
    svgChildren.push(
      React.createElement('path', { key: 'fill', d: fillPath, fill: `${GOLD}0D` })
    )
  }

  // Gold line
  if (linePath) {
    svgChildren.push(
      React.createElement('path', { key: 'line', d: linePath, fill: 'none', stroke: GOLD, strokeWidth: 3.5 })
    )
  }

  // Dots
  points.forEach((dp, i) => {
    const px = (i / (points.length - 1)) * gw
    const py = gh - ((dp.score - 1) / 9) * gh
    svgChildren.push(
      React.createElement('circle', { key: `d${i}`, cx: px, cy: py, r: 5, fill: GOLD })
    )
  })

  // Y-axis labels
  const yLabels = [10, 7, 5, 1]
  const labelEls = yLabels.map((val) => {
    const topPct = ((10 - val) / 9) * 100
    return React.createElement('div', {
      key: `y${val}`,
      style: {
        position: 'absolute', left: 0, top: `${topPct}%`,
        fontSize: 18, color: 'rgba(255,255,255,0.4)', fontFamily: 'DM Sans',
        width: 36, textAlign: 'right', marginTop: -9,
      },
    }, val.toString())
  })

  return React.createElement('div', {
    style: { display: 'flex', flexDirection: 'row', width: '100%', height: '100%' },
  },
    React.createElement('div', {
      style: { width: 48, position: 'relative', flexShrink: 0, display: 'flex', flexDirection: 'column' },
    }, ...labelEls),
    React.createElement('svg', {
      width: gw, height: gh, viewBox: `0 0 ${gw} ${gh}`, style: { flex: 1 },
    }, ...svgChildren)
  )
}

// Build borderless graph (for Graph Hero — no container, faint grid lines, gold area gradient)
function buildBorderlessGraph(
  points: { score: number }[],
  gw: number,
  gh: number
): React.ReactElement {
  const linePath = buildLinePath(points, gw, gh)
  const fillPath = buildFillPath(points, gw, gh)

  const svgChildren: React.ReactElement[] = []

  // Faint horizontal grid lines at scores 2, 4, 6, 8, 10
  for (const score of [2, 4, 6, 8, 10]) {
    const y = yForScore(score, gh)
    svgChildren.push(
      React.createElement('line', {
        key: `grid${score}`, x1: 0, y1: y, x2: gw, y2: y,
        stroke: 'rgba(255,255,255,0.06)', strokeWidth: 1,
      })
    )
  }

  // Gold area fill — very subtle so poster bleeds through
  if (fillPath) {
    svgChildren.push(
      React.createElement('path', { key: 'fill', d: fillPath, fill: `${GOLD}0D` })
    )
  }

  // Gold line — slightly thicker
  if (linePath) {
    svgChildren.push(
      React.createElement('path', { key: 'line', d: linePath, fill: 'none', stroke: GOLD, strokeWidth: 4 })
    )
  }

  // Dots — slightly larger
  points.forEach((dp, i) => {
    const px = (i / (points.length - 1)) * gw
    const py = gh - ((dp.score - 1) / 9) * gh
    // Outer glow
    svgChildren.push(
      React.createElement('circle', { key: `glow${i}`, cx: px, cy: py, r: 10, fill: `${GOLD}30` })
    )
    svgChildren.push(
      React.createElement('circle', { key: `d${i}`, cx: px, cy: py, r: 6, fill: GOLD })
    )
  })

  // Y-axis labels
  const yLabels = [10, 8, 6, 4, 2]
  const labelEls = yLabels.map((val) => {
    const topPct = ((10 - val) / 9) * 100
    return React.createElement('div', {
      key: `y${val}`,
      style: {
        position: 'absolute', left: 0, top: `${topPct}%`,
        fontSize: 20, color: 'rgba(255,255,255,0.3)', fontFamily: 'DM Sans',
        width: 36, textAlign: 'right', marginTop: -10,
      },
    }, val.toString())
  })

  return React.createElement('div', {
    style: { display: 'flex', flexDirection: 'row', width: '100%', height: '100%' },
  },
    React.createElement('div', {
      style: { width: 48, position: 'relative', flexShrink: 0, display: 'flex', flexDirection: 'column' },
    }, ...labelEls),
    React.createElement('svg', {
      width: gw, height: gh, viewBox: `0 0 ${gw} ${gh}`, style: { flex: 1 },
    }, ...svgChildren)
  )
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
    const style = styleParam === 'graph-hero' ? 'graph-hero' : 'cinematic-overlay'

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
    const beatRatings = review.beatRatings as Record<string, number> | null
    const graphLabels = (review.film.sentimentGraph?.dataPoints as { label: string; score: number }[]) || []
    // Use portrait poster (2:3 ratio)
    const posterUrl = review.film.posterUrl
      ? `https://image.tmdb.org/t/p/w780${review.film.posterUrl}`
      : null

    const userPoints = buildUserDataPoints(beatRatings, graphLabels)
    const hasGraph = userPoints.length >= 2

    const fonts = await loadFonts()
    let element: React.ReactElement

    const graphW = W - 200

    // Shared poster background element
    function posterBg(gradientStops: string): React.ReactElement[] {
      return [
        posterUrl
          ? React.createElement('img', {
              key: 'poster',
              src: posterUrl,
              style: {
                position: 'absolute', top: 0, left: 0, width: W, height: H,
                objectFit: 'cover', objectPosition: 'center top',
              },
            })
          : React.createElement('div', {
              key: 'poster-fallback',
              style: { position: 'absolute', top: 0, left: 0, width: W, height: H, backgroundColor: '#1a1d28' },
            }),
        React.createElement('div', {
          key: 'grad',
          style: {
            position: 'absolute', top: 0, left: 0, width: W, height: H,
            background: gradientStops,
          },
        }),
      ]
    }

    if (style === 'cinematic-overlay') {
      // ──────────────────────────────────────────────
      // Style A — Cinematic Overlay
      // Branding top-left, score 42px top-right
      // Poster visible in middle section
      // Title 24px + meta lower-middle
      // Graph in semi-transparent panel with gold glow
      // Quote below, "cinemagraphs.ca" centered bottom
      // ──────────────────────────────────────────────

      const graphH = 360

      element = React.createElement('div', {
        style: { width: W, height: H, display: 'flex', flexDirection: 'column', backgroundColor: DARK, position: 'relative' },
      },
        ...posterBg(
          'linear-gradient(to bottom, rgba(15,17,23,0.15) 0%, rgba(15,17,23,0.2) 30%, rgba(15,17,23,0.45) 50%, rgba(15,17,23,0.75) 60%, rgba(15,17,23,0.9) 70%, rgba(15,17,23,0.97) 80%)'
        ),

        // Top bar: branding left, score right
        React.createElement('div', {
          style: { position: 'absolute', top: 60, left: 60, right: 60, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
        },
          React.createElement('div', {
            style: { fontSize: 18, fontWeight: 700, color: GOLD, letterSpacing: 5, fontFamily: 'DM Sans', marginTop: 12 },
          }, 'CINEMAGRAPHS'),
          React.createElement('div', {
            style: { fontSize: 60, fontWeight: 700, color: GOLD, fontFamily: 'Playfair Display', lineHeight: 1 },
          }, score.toFixed(1))
        ),

        // Film title + meta — lower middle area, pushed down to show more poster
        React.createElement('div', {
          style: { position: 'absolute', top: 1140, left: 60, right: 60, display: 'flex', flexDirection: 'column' },
        },
          React.createElement('div', {
            style: { fontSize: 30, fontWeight: 700, color: IVORY, fontFamily: 'Playfair Display', lineHeight: 1.2 },
          }, filmTitle),
          (year || director)
            ? React.createElement('div', {
                style: { fontSize: 13, color: 'rgba(255,255,255,0.45)', marginTop: 10, fontFamily: 'DM Sans' },
              }, [year, director].filter(Boolean).join('  \u00b7  '))
            : null
        ),

        // "SENTIMENT ARC" label
        hasGraph
          ? React.createElement('div', {
              style: { position: 'absolute', top: 1240, left: 60, fontSize: 12, fontWeight: 700, color: GOLD, letterSpacing: 5, fontFamily: 'DM Sans' },
            }, 'SENTIMENT ARC')
          : null,

        // Graph in semi-transparent panel — bottom 30% of image
        hasGraph
          ? React.createElement('div', {
              style: {
                position: 'absolute', top: 1280, left: 40, right: 40, height: graphH + 60,
                backgroundColor: 'rgba(15,17,23,0.65)', borderRadius: 16,
                border: `1px solid ${GOLD}35`,
                boxShadow: `0 0 30px ${GOLD}15, inset 0 0 20px ${GOLD}08`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '30px 20px',
              },
            }, buildGraphPanel(userPoints, graphW, graphH))
          : null,

        // Quote with gold left border
        quoteText
          ? React.createElement('div', {
              style: {
                position: 'absolute', top: hasGraph ? 1710 : 1280, left: 60, right: 60,
                display: 'flex', flexDirection: 'row',
              },
            },
              React.createElement('div', {
                style: { width: 4, backgroundColor: GOLD, borderRadius: 2, marginRight: 24, flexShrink: 0 },
              }),
              React.createElement('div', {
                style: { display: 'flex', flexDirection: 'column', flex: 1 },
              },
                React.createElement('div', {
                  style: { fontSize: 26, fontStyle: 'italic', color: 'rgba(255,255,255,0.55)', lineHeight: 1.5, fontFamily: 'DM Sans' },
                }, `\u201c${quoteText}\u201d`),
                React.createElement('div', {
                  style: { fontSize: 22, color: GOLD, marginTop: 5, fontFamily: 'DM Sans', alignSelf: 'flex-end' },
                }, `\u2014 ${username}`)
              )
            )
          : null,

        // Bottom: "cinemagraphs.ca" centered
        React.createElement('div', {
          style: { position: 'absolute', bottom: 55, left: 0, width: W, display: 'flex', justifyContent: 'center' },
        },
          React.createElement('div', {
            style: { fontSize: 20, color: 'rgba(255,255,255,0.3)', fontFamily: 'DM Sans' },
          }, 'cinemagraphs.ca')
        ),

        // Gold accent bar
        React.createElement('div', {
          style: { position: 'absolute', bottom: 0, left: 0, width: W, height: 4, backgroundColor: GOLD },
        })
      )

    } else {
      // ──────────────────────────────────────────────
      // Style B — Graph Hero
      // Lighter gradient (poster more visible)
      // Branding at top, title + score same baseline row (28px)
      // Borderless graph floating over poster — no container box
      // Larger graph with faint grid lines and gold area fill
      // Compact quote below
      // ──────────────────────────────────────────────

      const graphH = 480

      element = React.createElement('div', {
        style: { width: W, height: H, display: 'flex', flexDirection: 'column', backgroundColor: DARK, position: 'relative' },
      },
        ...posterBg(
          'linear-gradient(to bottom, rgba(15,17,23,0.1) 0%, rgba(15,17,23,0.15) 35%, rgba(15,17,23,0.4) 50%, rgba(15,17,23,0.7) 60%, rgba(15,17,23,0.88) 70%, rgba(15,17,23,0.96) 80%)'
        ),

        // Top branding
        React.createElement('div', {
          style: { position: 'absolute', top: 60, left: 60, right: 60, display: 'flex', justifyContent: 'center' },
        },
          React.createElement('div', {
            style: { fontSize: 16, fontWeight: 700, color: GOLD, letterSpacing: 6, fontFamily: 'DM Sans' },
          }, 'CINEMAGRAPHS')
        ),

        // Title + score on same baseline row — pushed down for more poster visibility
        React.createElement('div', {
          style: { position: 'absolute', top: 1120, left: 60, right: 60, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
        },
          React.createElement('div', {
            style: { display: 'flex', flexDirection: 'column', flex: 1, marginRight: 20 },
          },
            React.createElement('div', {
              style: { fontSize: 30, fontWeight: 700, color: IVORY, fontFamily: 'Playfair Display', lineHeight: 1.2 },
            }, filmTitle),
            (year || director)
              ? React.createElement('div', {
                  style: { fontSize: 13, color: 'rgba(255,255,255,0.4)', marginTop: 8, fontFamily: 'DM Sans' },
                }, [year, director].filter(Boolean).join('  \u00b7  '))
              : null
          ),
          React.createElement('div', {
            style: { fontSize: 56, fontWeight: 700, color: GOLD, fontFamily: 'Playfair Display', lineHeight: 1 },
          }, score.toFixed(1))
        ),

        // "SENTIMENT ARC" label
        hasGraph
          ? React.createElement('div', {
              style: { position: 'absolute', top: 1220, left: 60, fontSize: 12, fontWeight: 700, color: GOLD, letterSpacing: 5, fontFamily: 'DM Sans' },
            }, 'SENTIMENT ARC')
          : null,

        // Borderless graph — floating in bottom 30%
        hasGraph
          ? React.createElement('div', {
              style: {
                position: 'absolute', top: 1260, left: 40, right: 40, height: graphH,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              },
            }, buildBorderlessGraph(userPoints, graphW, graphH))
          : null,

        // Compact quote
        quoteText
          ? React.createElement('div', {
              style: {
                position: 'absolute', top: hasGraph ? 1760 : 1260, left: 60, right: 60,
                display: 'flex', flexDirection: 'row',
              },
            },
              React.createElement('div', {
                style: { width: 3, backgroundColor: GOLD, borderRadius: 2, marginRight: 20, flexShrink: 0 },
              }),
              React.createElement('div', {
                style: { display: 'flex', flexDirection: 'column', flex: 1 },
              },
                React.createElement('div', {
                  style: { fontSize: 24, fontStyle: 'italic', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5, fontFamily: 'DM Sans' },
                }, `\u201c${quoteText}\u201d`),
                React.createElement('div', {
                  style: { fontSize: 20, color: GOLD, marginTop: 5, fontFamily: 'DM Sans', alignSelf: 'flex-end' },
                }, `\u2014 ${username}`)
              )
            )
          : null,

        // Bottom branding
        React.createElement('div', {
          style: { position: 'absolute', bottom: 55, left: 0, width: W, display: 'flex', justifyContent: 'center' },
        },
          React.createElement('div', {
            style: { fontSize: 20, color: 'rgba(255,255,255,0.3)', fontFamily: 'DM Sans' },
          }, 'cinemagraphs.ca')
        ),

        // Gold accent bar
        React.createElement('div', {
          style: { position: 'absolute', bottom: 0, left: 0, width: W, height: 4, backgroundColor: GOLD },
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
