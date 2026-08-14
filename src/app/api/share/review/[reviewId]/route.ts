import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import satori from 'satori'
import sharp from 'sharp'
import React from 'react'
import { fetchTmdbImageAsDataUri } from '@/lib/tmdb-image'
import { buildBeatOverlay } from '@/lib/beat-overlay'
import { hasRuntime, buildRulerMinutes, formatRulerLabel } from '@/lib/time-axis'

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

// The film's beat structure as stored on SentimentGraph.dataPoints; the
// poster only reads these three fields.
interface GraphBeat {
  label: string
  score: number
  timeMidpoint?: number
}

// Build user's sentiment data points from their beatRatings. Keeps each rated
// beat's timeMidpoint so the graph can place it at its true position in the
// runtime. The typeof check (not a bare undefined test) keeps a legacy null
// rating from becoming a NaN coordinate.
// Exported for tests only; Next.js ignores non-handler exports from route
// files (precedent: buildSparklinePng in src/app/api/og/list/route.ts).
export function buildUserDataPoints(
  beatRatings: Record<string, number> | null,
  graphLabels: GraphBeat[]
): GraphBeat[] {
  if (!beatRatings || !graphLabels.length) return []
  return graphLabels
    .filter((dp) => typeof beatRatings[dp.label] === 'number')
    .map((dp) => ({
      label: dp.label,
      score: beatRatings[dp.label],
      timeMidpoint: dp.timeMidpoint,
    }))
}

// Padding to prevent dots at edges from being clipped
const GRAPH_PAD_TOP = 14
const GRAPH_PAD_BOTTOM = 6
const GRAPH_PAD_LEFT = 12
const GRAPH_PAD_RIGHT = 12

// X-axis ruler. Interval selection and tick minutes live in lib/time-axis,
// shared with the on-page recharts graphs; this route maps the minutes onto
// poster pixel coordinates and labels them with formatRulerLabel, while the
// page graphs keep their own formatTime ("1h 00m" where the poster says "1h").
// Re-exported for tests only, like buildUserDataPoints above.
export { formatRulerLabel }

export interface RulerTick {
  minute: number
  label: string
  x: number
}

// Tick x is the minute as a fraction of the runtime across the same drawable
// width the beats use (same padding constants), so the ruler and the plot
// share one coordinate space.
// Exported for tests only, like buildUserDataPoints above.
export function buildRulerTicks(
  runtimeMin: number | null | undefined,
  gw: number
): RulerTick[] {
  if (!hasRuntime(runtimeMin)) return []
  const drawW = gw - (GRAPH_PAD_LEFT + GRAPH_PAD_RIGHT)
  return buildRulerMinutes(runtimeMin).map((minute) => ({
    minute,
    label: formatRulerLabel(minute),
    x: GRAPH_PAD_LEFT + (minute / runtimeMin) * drawW,
  }))
}

// Shared x-axis ruler row for both poster styles. Labels sit at a percentage
// of the flex-1 box after the 48px y-label gutter: satori stretches the graph
// svg into that same box (preserveAspectRatio "none"), so a label centred at
// (x / gw)% lands on its vertical gridline at whatever width the row renders.
function buildRulerRow(ticks: RulerTick[], gw: number, fontSize: number): React.ReactElement {
  const labelEls = ticks.map((tick) =>
    React.createElement('div', {
      key: `x${tick.minute}`,
      style: {
        // flex centering, not textAlign: satori leaves textAlign'd text at
        // the box's left edge, which pushed every label off its gridline
        position: 'absolute', left: `${(tick.x / gw) * 100}%`, top: 0,
        width: 80, marginLeft: -40, display: 'flex', justifyContent: 'center',
        fontSize, color: 'rgba(255,255,255,0.3)', fontFamily: 'DM Sans',
      },
    }, tick.label)
  )
  return React.createElement('div', {
    style: { display: 'flex', flexDirection: 'row', marginLeft: 48, marginTop: 4, height: fontSize + 4 },
  },
    React.createElement('div', {
      style: { position: 'relative', flex: 1, display: 'flex' },
    }, ...labelEls)
  )
}

// Dynamic y-axis: floor one whole number below the lowest data point, ceiling always 10
function computeYFloor(points: { score: number }[]): number {
  if (points.length === 0) return 0
  const minScore = Math.min(...points.map((p) => p.score))
  return Math.max(0, Math.floor(minScore) - 1)
}

function computeYLabels(yFloor: number): number[] {
  const range = 10 - yFloor
  const step = range > 5 ? 2 : 1
  const labels: number[] = []
  for (let v = 10; v >= yFloor; v -= step) labels.push(v)
  if (labels[labels.length - 1] !== yFloor) labels.push(yFloor)
  return labels
}

// Shared graph geometry for both poster styles. Every coordinate comes from
// buildBeatOverlay, so rated beats sit at their stored timeMidpoint fraction
// of the runtime (falling back to index spacing when timing data is absent)
// and the x-axis ruler marks round minutes in the same coordinate space,
// pairing no label with a beat. Lines and fills are built one
// per consecutive run of rated beats: a single edge-to-edge fill would
// re-assert, in a softer colour, the exact ratings a broken line stopped
// asserting across unrated gaps. A run of one contributes no line and no
// fill, only its dot.
//
// The y floor stays dynamic (computeYFloor), unlike the review page's fixed
// floor of 1, so the poster deliberately shows a different vertical shape
// than the review page for the same ratings.
// Exported for tests only, like buildUserDataPoints above.
export function buildPosterGraph(
  dataPoints: GraphBeat[],
  beatRatings: Record<string, number> | null,
  gw: number,
  gh: number,
  runtimeMin: number | null
): {
  yFloor: number
  linePaths: string[]
  fillPaths: string[]
  dots: { x: number; y: number }[]
} {
  const userPoints = buildUserDataPoints(beatRatings, dataPoints)
  const yFloor = computeYFloor(userPoints)
  const overlay = buildBeatOverlay(dataPoints, beatRatings, {
    width: gw,
    height: gh,
    padding: {
      top: GRAPH_PAD_TOP,
      right: GRAPH_PAD_RIGHT,
      bottom: GRAPH_PAD_BOTTOM,
      left: GRAPH_PAD_LEFT,
    },
    yFloor,
    yCeiling: 10,
    runtimeMinutes: runtimeMin ?? undefined,
  })

  const drawableRuns = overlay.runs.filter((run) => run.length >= 2)
  const toLine = (run: { x: number; y: number }[]) =>
    run.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  return {
    yFloor,
    linePaths: drawableRuns.map(toLine),
    fillPaths: drawableRuns.map((run) => {
      const firstX = run[0].x
      const lastX = run[run.length - 1].x
      return `${toLine(run)} L${lastX.toFixed(1)},${gh.toFixed(1)} L${firstX.toFixed(1)},${gh.toFixed(1)} Z`
    }),
    dots: overlay.dots,
  }
}

function yForScore(score: number, h: number, yFloor: number): number {
  const range = 10 - yFloor
  const drawH = h - GRAPH_PAD_TOP - GRAPH_PAD_BOTTOM
  return GRAPH_PAD_TOP + drawH - ((score - yFloor) / range) * drawH
}

// Build graph panel with Y-axis labels + SVG chart (for Cinematic Overlay — with container)
function buildGraphPanel(
  dataPoints: GraphBeat[],
  beatRatings: Record<string, number> | null,
  gw: number,
  gh: number,
  runtimeMin: number | null
): React.ReactElement {
  const { yFloor, linePaths, fillPaths, dots } = buildPosterGraph(
    dataPoints, beatRatings, gw, gh, runtimeMin
  )
  const range = 10 - yFloor
  const midScore = yFloor + range / 2
  const midY = yForScore(midScore, gh, yFloor)

  const svgChildren: React.ReactElement[] = []

  // Dashed midline at midpoint of visible range
  svgChildren.push(
    React.createElement('line', {
      key: 'mid', x1: 0, y1: midY, x2: gw, y2: midY,
      stroke: 'rgba(255,255,255,0.12)', strokeWidth: 1, strokeDasharray: '8 6',
    })
  )

  // Faint vertical grid lines at each ruler tick, matching the treatment of
  // the horizontal grid lines in buildBorderlessGraph
  for (const tick of buildRulerTicks(runtimeMin, gw)) {
    svgChildren.push(
      React.createElement('line', {
        key: `vgrid${tick.minute}`, x1: tick.x, y1: 0, x2: tick.x, y2: gh,
        stroke: 'rgba(255,255,255,0.06)', strokeWidth: 1,
      })
    )
  }

  // Fill under each run with very subtle gold tint
  fillPaths.forEach((d, i) => {
    svgChildren.push(
      React.createElement('path', { key: `fill${i}`, d, fill: `${GOLD}0D` })
    )
  })

  // Gold line per run
  linePaths.forEach((d, i) => {
    svgChildren.push(
      React.createElement('path', { key: `line${i}`, d, fill: 'none', stroke: GOLD, strokeWidth: 3.5 })
    )
  })

  // Dots
  dots.forEach((p, i) => {
    svgChildren.push(
      React.createElement('circle', { key: `d${i}`, cx: p.x, cy: p.y, r: 5, fill: GOLD })
    )
  })

  // Y-axis labels — dynamic based on data range
  const yLabels = computeYLabels(yFloor)
  const labelEls = yLabels.map((val) => {
    const topPct = ((10 - val) / range) * 100
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
  dataPoints: GraphBeat[],
  beatRatings: Record<string, number> | null,
  gw: number,
  gh: number,
  runtimeMin?: number | null
): React.ReactElement {
  const { yFloor, linePaths, fillPaths, dots } = buildPosterGraph(
    dataPoints, beatRatings, gw, gh, runtimeMin ?? null
  )
  const range = 10 - yFloor

  const svgChildren: React.ReactElement[] = []

  // Faint horizontal grid lines at y-axis label positions
  const yLabels = computeYLabels(yFloor)
  for (const score of yLabels) {
    const y = yForScore(score, gh, yFloor)
    svgChildren.push(
      React.createElement('line', {
        key: `grid${score}`, x1: 0, y1: y, x2: gw, y2: y,
        stroke: 'rgba(255,255,255,0.06)', strokeWidth: 1,
      })
    )
  }

  // Faint vertical grid lines at each ruler tick, same treatment as above
  const rulerTicks = buildRulerTicks(runtimeMin, gw)
  for (const tick of rulerTicks) {
    svgChildren.push(
      React.createElement('line', {
        key: `vgrid${tick.minute}`, x1: tick.x, y1: 0, x2: tick.x, y2: gh,
        stroke: 'rgba(255,255,255,0.06)', strokeWidth: 1,
      })
    )
  }

  // Gold area fill per run — very subtle so poster bleeds through
  fillPaths.forEach((d, i) => {
    svgChildren.push(
      React.createElement('path', { key: `fill${i}`, d, fill: `${GOLD}0D` })
    )
  })

  // Gold line per run — slightly thicker
  linePaths.forEach((d, i) => {
    svgChildren.push(
      React.createElement('path', { key: `line${i}`, d, fill: 'none', stroke: GOLD, strokeWidth: 4 })
    )
  })

  // Dots — slightly larger
  dots.forEach((p, i) => {
    // Outer glow
    svgChildren.push(
      React.createElement('circle', { key: `glow${i}`, cx: p.x, cy: p.y, r: 10, fill: `${GOLD}30` })
    )
    svgChildren.push(
      React.createElement('circle', { key: `d${i}`, cx: p.x, cy: p.y, r: 6, fill: GOLD })
    )
  })

  // Y-axis labels — dynamic based on data range
  const labelEls = yLabels.map((val) => {
    const topPct = ((10 - val) / range) * 100
    return React.createElement('div', {
      key: `y${val}`,
      style: {
        position: 'absolute', left: 0, top: `${topPct}%`,
        fontSize: 20, color: 'rgba(255,255,255,0.3)', fontFamily: 'DM Sans',
        width: 36, textAlign: 'right', marginTop: -10,
      },
    }, val.toString())
  })

  // X-axis ruler labels; no runtime, no ticks, no row
  const xAxisEl = rulerTicks.length ? buildRulerRow(rulerTicks, gw, 16) : null

  return React.createElement('div', {
    style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%' },
  },
    React.createElement('div', {
      style: { display: 'flex', flexDirection: 'row', flex: 1 },
    },
      React.createElement('div', {
        style: { width: 48, position: 'relative', flexShrink: 0, display: 'flex', flexDirection: 'column' },
      }, ...labelEls),
      React.createElement('svg', {
        width: gw, height: gh, viewBox: `0 0 ${gw} ${gh}`, style: { flex: 1 },
      }, ...svgChildren)
    ),
    xAxisEl
  )
}

// ──────────────────────────────────────────────
// Cinematic poster builder (16:9 landscape)
// Backdrop left, graph right, score + title overlay
// ──────────────────────────────────────────────
function buildCinematicPoster(
  filmTitle: string,
  year: string,
  director: string,
  score: number,
  username: string,
  quoteText: string,
  backdropSrc: string | null,
  dataPoints: GraphBeat[],
  beatRatings: Record<string, number> | null,
  hasGraph: boolean,
  runtimeMin: number | null
): React.ReactElement {
  const CW = 1080
  const CH = 608
  const graphSvgW = 432
  const graphH = 380

  const children: (React.ReactElement | null)[] = []

  // Full backdrop image
  children.push(
    backdropSrc
      ? React.createElement('img', {
          key: 'bg', src: backdropSrc,
          style: {
            position: 'absolute', top: 0, left: 0, width: CW, height: CH,
            objectFit: 'cover', objectPosition: 'center center',
          },
        })
      : React.createElement('div', {
          key: 'bg',
          style: { position: 'absolute', top: 0, left: 0, width: CW, height: CH, backgroundColor: '#1a1d28' },
        })
  )

  // Gradient: left→right (backdrop visible left, dark right for graph)
  children.push(
    React.createElement('div', {
      key: 'grad-lr',
      style: {
        position: 'absolute', top: 0, left: 0, width: CW, height: CH,
        background: 'linear-gradient(to right, rgba(15,17,23,0.25) 0%, rgba(15,17,23,0.55) 35%, rgba(15,17,23,0.88) 55%, rgba(15,17,23,0.97) 70%)',
      },
    })
  )

  // Gradient: top→bottom (text readability on left)
  children.push(
    React.createElement('div', {
      key: 'grad-bt',
      style: {
        position: 'absolute', top: 0, left: 0, width: CW, height: CH,
        background: 'linear-gradient(to bottom, rgba(15,17,23,0.15) 0%, rgba(15,17,23,0.3) 60%, rgba(15,17,23,0.7) 100%)',
      },
    })
  )

  // Top-left branding
  children.push(
    React.createElement('div', {
      key: 'brand',
      style: {
        position: 'absolute', top: 30, left: 44,
        fontSize: 11, fontWeight: 700, color: GOLD, letterSpacing: 5, fontFamily: 'DM Sans',
      },
    }, 'CINEMAGRAPHS')
  )

  // Left column: title + year/director + score
  const leftContent: (React.ReactElement | null)[] = [
    React.createElement('div', {
      key: 'title',
      style: {
        fontSize: 28, fontWeight: 700, color: IVORY, fontFamily: 'Playfair Display', lineHeight: 1.2,
      },
    }, filmTitle),
  ]
  if (year || director) {
    leftContent.push(
      React.createElement('div', {
        key: 'meta',
        style: { fontSize: 13, color: 'rgba(255,255,255,0.45)', marginTop: 6, fontFamily: 'DM Sans' },
      }, [year, director].filter(Boolean).join('  \u00b7  '))
    )
  }
  leftContent.push(
    React.createElement('div', {
      key: 'score',
      style: { display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 24 },
    },
      React.createElement('div', {
        style: { fontSize: 52, fontWeight: 700, color: GOLD, fontFamily: 'Playfair Display', lineHeight: 1 },
      }, score.toFixed(1)),
      React.createElement('div', {
        style: { fontSize: 14, color: 'rgba(255,255,255,0.3)', fontFamily: 'DM Sans' },
      }, '/ 10')
    )
  )
  children.push(
    React.createElement('div', {
      key: 'left',
      style: {
        position: 'absolute', top: 72, left: 44, width: 440,
        display: 'flex', flexDirection: 'column',
      },
    }, ...leftContent)
  )

  // Left bottom: quote or username
  if (quoteText) {
    children.push(
      React.createElement('div', {
        key: 'quote',
        style: {
          position: 'absolute', bottom: 44, left: 44, width: 420,
          display: 'flex', flexDirection: 'row',
        },
      },
        React.createElement('div', {
          style: { width: 2, backgroundColor: GOLD, borderRadius: 1, marginRight: 14, flexShrink: 0 },
        }),
        React.createElement('div', {
          style: { display: 'flex', flexDirection: 'column', flex: 1 },
        },
          React.createElement('div', {
            style: {
              fontSize: 14, fontStyle: 'italic', color: 'rgba(255,255,255,0.45)',
              lineHeight: 1.5, fontFamily: 'DM Sans',
            },
          }, `\u201c${truncateAtWord(quoteText, 90)}\u201d`),
          React.createElement('div', {
            style: { fontSize: 12, color: GOLD, marginTop: 3, fontFamily: 'DM Sans', alignSelf: 'flex-end' },
          }, `\u2014 ${username}`)
        )
      )
    )
  } else {
    children.push(
      React.createElement('div', {
        key: 'user',
        style: {
          position: 'absolute', bottom: 50, left: 44,
          fontSize: 14, color: 'rgba(255,255,255,0.35)', fontFamily: 'DM Sans',
        },
      }, `reviewed by ${username}`)
    )
  }

  // Right side: SENTIMENT ARC label
  if (hasGraph) {
    children.push(
      React.createElement('div', {
        key: 'arc-label',
        style: {
          position: 'absolute', top: 36, left: 560,
          fontSize: 11, fontWeight: 700, color: GOLD, letterSpacing: 5, fontFamily: 'DM Sans',
        },
      }, 'SENTIMENT ARC')
    )

    // Graph panel + x-axis ruler; no runtime, no ticks, no row
    const graphChildren: (React.ReactElement | null)[] = [
      buildGraphPanel(dataPoints, beatRatings, graphSvgW, graphH, runtimeMin),
    ]
    const rulerTicks = buildRulerTicks(runtimeMin, graphSvgW)
    if (rulerTicks.length) {
      graphChildren.push(buildRulerRow(rulerTicks, graphSvgW, 12))
    }
    children.push(
      React.createElement('div', {
        key: 'graph',
        style: {
          position: 'absolute', top: 62, left: 560, width: 480, height: graphH + 30,
          display: 'flex', flexDirection: 'column',
        },
      }, ...graphChildren)
    )
  }

  // Bottom-right branding
  children.push(
    React.createElement('div', {
      key: 'footer',
      style: {
        position: 'absolute', bottom: 14, right: 40,
        fontSize: 12, color: 'rgba(255,255,255,0.2)', fontFamily: 'DM Sans',
      },
    }, 'cinemagraphs.ca')
  )

  // Gold accent bar
  children.push(
    React.createElement('div', {
      key: 'gold-bar',
      style: {
        position: 'absolute', bottom: 0, left: 0, width: CW, height: 3, backgroundColor: GOLD,
      },
    })
  )

  return React.createElement('div', {
    style: {
      width: CW, height: CH, display: 'flex', flexDirection: 'column',
      backgroundColor: DARK, position: 'relative', overflow: 'hidden',
    },
  }, ...children)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> }
) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { reviewId } = await params
    const style = request.nextUrl.searchParams.get('style') || 'graph-hero'

    const review = await prisma.userReview.findUnique({
      where: { id: reviewId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        film: {
          select: {
            title: true,
            posterUrl: true,
            backdropUrl: true,
            releaseDate: true,
            director: true,
            runtime: true,
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
    const graphLabels = (review.film.sentimentGraph?.dataPoints as unknown as GraphBeat[]) || []
    // Pre-fetch poster + backdrop as data URIs. Satori cannot decode WebP/AVIF
    // (its image handler throws "u is not iterable"), and TMDB serves WebP based
    // on Cloudflare cache state, so we hand satori bytes directly rather than
    // letting it fetch the URLs itself.
    let posterUrl: string | null = null
    if (review.film.posterUrl) {
      try {
        posterUrl = await fetchTmdbImageAsDataUri(
          `https://image.tmdb.org/t/p/w780${review.film.posterUrl}`,
          { filmId: review.filmId },
        )
      } catch (err) {
        console.error('Share image: poster fetch failed:', err)
      }
    }

    let backdropDataUri: string | null = null
    if (review.film.backdropUrl) {
      try {
        backdropDataUri = await fetchTmdbImageAsDataUri(
          `https://image.tmdb.org/t/p/w1280${review.film.backdropUrl}`,
          { filmId: review.filmId },
        )
      } catch (err) {
        console.error('Share image: backdrop fetch failed:', err)
      }
    }
    // Backdrop falls back to poster when missing or its fetch failed (preserves
    // the prior URL-level fallback at the data-URI level).
    const backdropSrc = backdropDataUri ?? posterUrl

    // If we attempted both fetches and both failed, the rendered poster would
    // be all gray fallback boxes — better to surface a 500 via the existing
    // catch than ship an image with no film visual.
    if (
      review.film.posterUrl &&
      posterUrl === null &&
      review.film.backdropUrl &&
      backdropDataUri === null
    ) {
      throw new Error('Both poster and backdrop fetches failed; cannot generate share image')
    }

    const userPoints = buildUserDataPoints(beatRatings, graphLabels)
    const hasGraph = userPoints.length >= 2

    const fonts = await loadFonts()
    const satoriFonts = [
      { name: 'Playfair Display', data: fonts.playfair, style: 'normal' as const, weight: 700 as const },
      { name: 'DM Sans', data: fonts.dmSans, style: 'normal' as const, weight: 400 as const },
      { name: 'DM Sans', data: fonts.dmSansItalic, style: 'italic' as const, weight: 400 as const },
    ]

    // ──────────────────────────────────────────────
    // Cinematic style (16:9 landscape) — early return
    // ──────────────────────────────────────────────
    if (style === 'cinematic') {
      const cinElement = buildCinematicPoster(
        filmTitle, year, director, score, username, quoteText,
        backdropSrc, graphLabels, beatRatings, hasGraph, review.film.runtime
      )
      const cinSvg = await satori(cinElement, { width: 1080, height: 608, fonts: satoriFonts })
      const cinPng = await sharp(Buffer.from(cinSvg)).png().toBuffer()
      return new NextResponse(new Uint8Array(cinPng), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=0, must-revalidate',
        },
      })
    }

    // ──────────────────────────────────────────────
    // Graph Hero style (9:16 vertical) — default
    // ──────────────────────────────────────────────
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

    // ──────────────────────────────────────────────
    // Graph Hero style
    // Lighter gradient (poster more visible)
    // Branding at top, title + score same baseline row
    // Borderless graph floating over poster
    // Larger graph with faint grid lines and gold area fill
    // Compact quote below
    // ──────────────────────────────────────────────

    const graphH = 480

    const element = React.createElement('div', {
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
          }, buildBorderlessGraph(graphLabels, beatRatings, graphW, graphH, review.film.runtime))
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

    const svg = await satori(element, { width: W, height: H, fonts: satoriFonts })

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
