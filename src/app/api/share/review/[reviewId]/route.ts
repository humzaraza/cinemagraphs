import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let canvasModule: any = null
function getCanvas() {
  if (!canvasModule) {
    // Use eval to prevent Turbopack from statically analyzing the import
    canvasModule = eval("require('@napi-rs/canvas')")
    // Register a serif font if available
    try {
      const path = require('path')
      const fontPath = path.join(process.cwd(), 'public', 'fonts', 'PlayfairDisplay-Bold.ttf')
      canvasModule.GlobalFonts.registerFromPath(fontPath, 'Playfair')
    } catch {
      // Font not available, will fall back to serif
    }
  }
  return canvasModule
}

const W = 1080
const H = 1920

function ratingColor(score: number): string {
  return score >= 7 ? '#C8A951' : '#ef4444'
}

function wrapText(
  ctx: any,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const test = current ? `${current} ${word}` : word
    const metrics = ctx.measureText(test)
    if (metrics.width > maxWidth && current) {
      lines.push(current)
      if (lines.length >= maxLines) break
      current = word
    } else {
      current = test
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current)
  }
  return lines
}

function drawSentimentLine(
  ctx: any,
  dataPoints: { label: string; score: number }[],
  beatRatings: Record<string, number> | null,
  x: number,
  y: number,
  w: number,
  h: number
) {
  if (dataPoints.length < 2) return

  // Gold external line
  ctx.beginPath()
  ctx.strokeStyle = '#C8A951'
  ctx.lineWidth = 3
  for (let i = 0; i < dataPoints.length; i++) {
    const px = x + (i / (dataPoints.length - 1)) * w
    const py = y + h - ((dataPoints[i].score - 1) / 9) * h
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()

  // Gold gradient fill
  const lastIdx = dataPoints.length - 1
  const lastPx = x + w
  ctx.lineTo(lastPx, y + h)
  ctx.lineTo(x, y + h)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, y, 0, y + h)
  grad.addColorStop(0, 'rgba(200, 169, 81, 0.25)')
  grad.addColorStop(1, 'rgba(200, 169, 81, 0)')
  ctx.fillStyle = grad
  ctx.fill()

  // Teal user line if beat ratings exist
  if (beatRatings) {
    const matched = dataPoints
      .map((dp, i) => {
        const rating = beatRatings[dp.label]
        if (rating === undefined) return null
        return {
          x: x + (i / (dataPoints.length - 1)) * w,
          y: y + h - ((rating - 1) / 9) * h,
        }
      })
      .filter(Boolean) as { x: number; y: number }[]

    if (matched.length >= 2) {
      ctx.beginPath()
      ctx.strokeStyle = '#2DD4A8'
      ctx.lineWidth = 2
      ctx.setLineDash([8, 6])
      matched.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y)
        else ctx.lineTo(p.x, p.y)
      })
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const { reviewId } = await params
  const style = request.nextUrl.searchParams.get('style') === 'minimal' ? 'minimal' : 'full'

  const review = await prisma.userReview.findUnique({
    where: { id: reviewId },
    include: {
      user: { select: { id: true, name: true } },
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

  const { createCanvas: makeCanvas, loadImage: loadImg } = getCanvas()

  const canvas = makeCanvas(W, H)
  const ctx = canvas.getContext('2d')

  const filmTitle = review.film.title
  const year = review.film.releaseDate
    ? new Date(review.film.releaseDate).getFullYear().toString()
    : ''
  const director = review.film.director || ''
  const score = review.overallRating
  const quoteText = review.combinedText?.slice(0, 120) || ''
  const username = review.user.name || 'Anonymous'
  const dataPoints = (review.film.sentimentGraph?.dataPoints as { label: string; score: number }[]) || []
  const beatRatings = review.beatRatings as Record<string, number> | null

  // Try to load poster
  let posterImage: Awaited<ReturnType<typeof loadImg>> | null = null
  if (review.film.posterUrl) {
    try {
      posterImage = await loadImg(
        `https://image.tmdb.org/t/p/w500${review.film.posterUrl}`
      )
    } catch {
      // Poster failed to load, continue without it
    }
  }

  if (style === 'full') {
    await drawFullStyle(ctx, {
      posterImage,
      score,
      filmTitle,
      year,
      director,
      quoteText,
      username,
      dataPoints,
      beatRatings,
    })
  } else {
    await drawMinimalStyle(ctx, {
      posterImage,
      score,
      filmTitle,
      year,
      quoteText,
      username,
      dataPoints,
      beatRatings,
    })
  }

  const buffer = canvas.toBuffer('image/png')
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `inline; filename="cinemagraphs-review.png"`,
      'Cache-Control': 'private, no-store',
    },
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface DrawParams {
  posterImage: any
  score: number
  filmTitle: string
  year: string
  director?: string
  quoteText: string
  username: string
  dataPoints: { label: string; score: number }[]
  beatRatings: Record<string, number> | null
}

async function drawFullStyle(ctx: any, p: DrawParams) {
  // Background
  ctx.fillStyle = '#0D0D1A'
  ctx.fillRect(0, 0, W, H)

  // Poster top 58%
  const posterH = Math.floor(H * 0.58)
  if (p.posterImage) {
    const imgW = p.posterImage.width
    const imgH = p.posterImage.height
    const scale = Math.max(W / imgW, posterH / imgH)
    const drawW = imgW * scale
    const drawH = imgH * scale
    const offsetX = (W - drawW) / 2
    const offsetY = (posterH - drawH) / 2
    ctx.drawImage(p.posterImage, offsetX, offsetY, drawW, drawH)
  }

  // Gradient fade from poster to dark
  const fadeGrad = ctx.createLinearGradient(0, posterH - 300, 0, posterH)
  fadeGrad.addColorStop(0, 'rgba(13, 13, 26, 0)')
  fadeGrad.addColorStop(1, '#0D0D1A')
  ctx.fillStyle = fadeGrad
  ctx.fillRect(0, posterH - 300, W, 300)

  let curY = posterH + 20

  // Large rating
  ctx.font = 'bold 120px "Playfair", Georgia, serif'
  ctx.fillStyle = ratingColor(p.score)
  ctx.textAlign = 'center'
  ctx.fillText(p.score.toFixed(1), W / 2, curY)
  curY += 30

  // Film title
  ctx.font = 'bold 48px "Playfair", Georgia, serif'
  ctx.fillStyle = '#F0E6D3'
  const titleLines = wrapText(ctx, p.filmTitle, W - 120, 2)
  for (const line of titleLines) {
    curY += 55
    ctx.fillText(line, W / 2, curY)
  }

  // Year / Director
  if (p.year || p.director) {
    curY += 40
    ctx.font = '28px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.fillText([p.year, p.director].filter(Boolean).join(' · '), W / 2, curY)
  }

  // Sentiment graph card
  if (p.dataPoints.length >= 2) {
    curY += 40
    const graphX = 60
    const graphW = W - 120
    const graphH = 160

    // Subtle card background
    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    ctx.beginPath()
    ctx.roundRect(graphX - 20, curY - 10, graphW + 40, graphH + 20, 12)
    ctx.fill()

    drawSentimentLine(ctx, p.dataPoints, p.beatRatings, graphX, curY, graphW, graphH)
    curY += graphH + 30
  }

  // Quote
  if (p.quoteText) {
    ctx.font = 'italic 30px "Playfair", Georgia, serif'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.textAlign = 'center'
    const quoteLines = wrapText(ctx, `"${p.quoteText}${p.quoteText.length >= 120 ? '...' : ''}"`, W - 120, 3)
    for (const line of quoteLines) {
      curY += 40
      ctx.fillText(line, W / 2, curY)
    }

    // Attribution
    curY += 35
    ctx.font = '26px sans-serif'
    ctx.fillStyle = 'rgba(200,169,81,0.7)'
    ctx.textAlign = 'right'
    ctx.fillText(`— ${p.username}`, W - 60, curY)
    ctx.textAlign = 'center'
  }

  // Branding at bottom
  const brandY = H - 60
  ctx.font = 'bold 36px "Playfair", Georgia, serif'
  ctx.fillStyle = '#C8A951'
  ctx.textAlign = 'center'
  ctx.fillText('Cinemagraphs', W / 2, brandY)
  ctx.font = '22px sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.fillText('cinemagraphs.ca', W / 2, brandY + 32)

  // Gold accent bar at bottom
  ctx.fillStyle = '#C8A951'
  ctx.fillRect(0, H - 6, W, 6)
}

async function drawMinimalStyle(ctx: any, p: DrawParams) {
  // Full poster background
  ctx.fillStyle = '#0D0D1A'
  ctx.fillRect(0, 0, W, H)

  if (p.posterImage) {
    const imgW = p.posterImage.width
    const imgH = p.posterImage.height
    const scale = Math.max(W / imgW, H / imgH)
    const drawW = imgW * scale
    const drawH = imgH * scale
    const offsetX = (W - drawW) / 2
    const offsetY = (H - drawH) / 2
    ctx.drawImage(p.posterImage, offsetX, offsetY, drawW, drawH)
  }

  // Dark overlay on bottom 55%
  const overlayTop = Math.floor(H * 0.45)
  const overlayGrad = ctx.createLinearGradient(0, overlayTop - 100, 0, overlayTop + 200)
  overlayGrad.addColorStop(0, 'rgba(13, 13, 26, 0)')
  overlayGrad.addColorStop(1, 'rgba(13, 13, 26, 0.92)')
  ctx.fillStyle = overlayGrad
  ctx.fillRect(0, overlayTop - 100, W, H - overlayTop + 100)

  // Solid dark for bottom portion
  ctx.fillStyle = 'rgba(13, 13, 26, 0.92)'
  ctx.fillRect(0, overlayTop + 200, W, H - overlayTop - 200)

  // Score top right
  ctx.font = 'bold 100px "Playfair", Georgia, serif'
  ctx.fillStyle = ratingColor(p.score)
  ctx.textAlign = 'right'
  ctx.fillText(p.score.toFixed(1), W - 60, 140)

  ctx.font = 'bold 18px sans-serif'
  ctx.fillStyle = 'rgba(200,169,81,0.6)'
  ctx.letterSpacing = '3px'
  ctx.fillText('CINEMAGRAPHS SCORE', W - 60, 170)
  ctx.letterSpacing = '0px'

  // Sentiment graph at bottom third
  if (p.dataPoints.length >= 2) {
    const graphY = H - 550
    const graphX = 60
    const graphW = W - 120
    const graphH = 180
    drawSentimentLine(ctx, p.dataPoints, p.beatRatings, graphX, graphY, graphW, graphH)
  }

  // Quote above film title
  let bottomY = H - 280
  if (p.quoteText) {
    ctx.font = 'italic 28px "Playfair", Georgia, serif'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.textAlign = 'left'
    const quoteLines = wrapText(ctx, `"${p.quoteText}${p.quoteText.length >= 120 ? '...' : ''}"`, W - 120, 3)
    for (const line of quoteLines) {
      ctx.fillText(line, 60, bottomY)
      bottomY += 38
    }

    // Attribution
    bottomY += 10
    ctx.font = '24px sans-serif'
    ctx.fillStyle = 'rgba(200,169,81,0.7)'
    ctx.fillText(`— ${p.username}`, 60, bottomY)
    bottomY += 40
  }

  // Film title bottom left
  const titleY = H - 100
  ctx.font = 'bold 44px "Playfair", Georgia, serif'
  ctx.fillStyle = '#F0E6D3'
  ctx.textAlign = 'left'
  const titleLines = wrapText(ctx, p.filmTitle, W - 300, 2)
  let ty = titleY - (titleLines.length - 1) * 50
  for (const line of titleLines) {
    ctx.fillText(line, 60, ty)
    ty += 50
  }

  if (p.year) {
    ctx.font = '26px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.fillText(p.year, 60, ty + 10)
  }

  // Branding bottom right
  ctx.font = 'bold 28px "Playfair", Georgia, serif'
  ctx.fillStyle = '#C8A951'
  ctx.textAlign = 'right'
  ctx.fillText('Cinemagraphs', W - 60, H - 80)
  ctx.font = '18px sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.fillText('cinemagraphs.ca', W - 60, H - 52)

  // Gold accent bar
  ctx.fillStyle = '#C8A951'
  ctx.fillRect(0, H - 6, W, 6)
}
