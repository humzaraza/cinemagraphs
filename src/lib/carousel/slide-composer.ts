import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

import { renderGraph, type DataPoint } from './graph-renderer'

// ── Public types ──────────────────────────────────────────────

export type FilmData = {
  title: string
  year: number
  runtime: string
  genres: string[]
  criticsScore: number
  dataPoints: DataPoint[]
  totalRuntimeMinutes: number
}

export type MiddleSlideContent = {
  pillLabel: string
  headline: string
  bodyCopy: string
  highlightBeatIndex: number
}

export type ComposeSlideInput = {
  film: FilmData
  slideNumber: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  format: '4x5' | '9x16'
  middleContent?: MiddleSlideContent
  backgroundImage?: Buffer | string
}

// ── Font loading (cached at module scope) ─────────────────────
// Use @expo-google-fonts TTFs — same pattern as graph-renderer.
// Paths are built from process.cwd() so Turbopack doesn't try to bundle the TTF as a module.

const NODE_MODULES = join(process.cwd(), 'node_modules')
const DM_SANS_400_PATH = join(NODE_MODULES, '@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf')
const DM_SANS_500_PATH = join(NODE_MODULES, '@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf')
const PLAYFAIR_700_PATH = join(NODE_MODULES, '@expo-google-fonts/playfair-display/700Bold/PlayfairDisplay_700Bold.ttf')
const PLAYFAIR_700_ITALIC_PATH = join(NODE_MODULES, '@expo-google-fonts/playfair-display/700Bold_Italic/PlayfairDisplay_700Bold_Italic.ttf')
const LIBRE_400_PATH = join(NODE_MODULES, '@expo-google-fonts/libre-baskerville/400Regular/LibreBaskerville_400Regular.ttf')
readFileSync(DM_SANS_400_PATH)
readFileSync(DM_SANS_500_PATH)
readFileSync(PLAYFAIR_700_PATH)
readFileSync(PLAYFAIR_700_ITALIC_PATH)
readFileSync(LIBRE_400_PATH)

const FONT_FILES = [
  DM_SANS_400_PATH,
  DM_SANS_500_PATH,
  PLAYFAIR_700_PATH,
  PLAYFAIR_700_ITALIC_PATH,
  LIBRE_400_PATH,
]

// ── Design tokens ─────────────────────────────────────────────

const COLORS = {
  bg: '#0D0D1A',
  gold: '#C8A951',
  teal: '#2DD4A8',
  red: '#E05555',
  cream: '#F5F0E1',
  creamMuted: 'rgba(245,240,225,0.7)',
  creamSubtle: 'rgba(245,240,225,0.5)',
  panelBg: 'rgba(13,13,26,0.25)',
  gradientTop: 'rgba(13,13,26,0.5)',
  gradientBottom: 'rgba(13,13,26,0.97)',
} as const

const DOT_COLOR_HEX: Record<'red' | 'gold' | 'teal', string> = {
  red: COLORS.red,
  gold: COLORS.gold,
  teal: COLORS.teal,
}

// Approximate glyph width / fontSize ratios used for manual wrap
// (resvg does not auto-wrap SVG <text>). Tuned slightly generous
// to avoid overflow — worst case is an extra wrap.
const CHAR_FACTOR_SANS = 0.52
const CHAR_FACTOR_SERIF = 0.54

// Synthetic placeholder gradients — one per slide. Hues mirror the
// structural reference HTML placeholders so test outputs are
// visually distinguishable.
const PLACEHOLDER_GRADIENTS = [
  { top: '#1a1a2e', bottom: '#0D0D1A' }, // 1
  { top: '#1a2438', bottom: '#0D1020' }, // 2
  { top: '#1e2a2a', bottom: '#0D1818' }, // 3
  { top: '#2b1e33', bottom: '#1a0D22' }, // 4
  { top: '#1f2a38', bottom: '#0D1a22' }, // 5
  { top: '#2a1a18', bottom: '#1a0D0A' }, // 6
  { top: '#1a2030', bottom: '#0D1018' }, // 7
  { top: '#1a1a2e', bottom: '#0D0D1A' }, // 8
] as const

// ── Format specs (positions + type scale) ─────────────────────

type FormatSpec = {
  canvasW: number
  canvasH: number
  graphZone: { x: number; y: number; w: number; h: number }
  panel: { x: number; y: number; w: number; h: number }
  topTextY: number
  bodyBottom: number
  brandNameSize: number
  brandTaglineSize: number
  counterSize: number
  bodySize: number
  beatLabelSize: number
}

function specFor(format: '4x5' | '9x16'): FormatSpec {
  if (format === '4x5') {
    const canvasW = 1080
    const canvasH = 1350
    const gW = 960
    const gH = 540
    const gx = (canvasW - gW) / 2
    const gy = (canvasH - gH) / 2
    return {
      canvasW,
      canvasH,
      graphZone: { x: gx, y: gy, w: gW, h: gH },
      panel: { x: gx - 20, y: gy - 20, w: gW + 40, h: gH + 40 },
      topTextY: 60,
      bodyBottom: 220,
      brandNameSize: 20,
      brandTaglineSize: 13,
      counterSize: 14,
      bodySize: 24,
      beatLabelSize: 28,
    }
  }
  const canvasW = 1080
  const canvasH = 1920
  const gW = 1000
  const gH = 1100
  const panelY = 288
  const gx = (canvasW - gW) / 2
  const gy = panelY + 20
  return {
    canvasW,
    canvasH,
    graphZone: { x: gx, y: gy, w: gW, h: gH },
    panel: { x: gx - 20, y: panelY, w: gW + 40, h: gH + 40 },
    topTextY: 120,
    bodyBottom: 220,
    brandNameSize: 24,
    brandTaglineSize: 15,
    counterSize: 16,
    bodySize: 30,
    beatLabelSize: 36,
  }
}

// ── Utility helpers ───────────────────────────────────────────

function fmt(n: number): string {
  return Number.isFinite(n) ? (+n.toFixed(3)).toString() : '0'
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Greedy word-wrap using an approximate glyph width.
function wrapText(
  text: string,
  maxWidthPx: number,
  fontSize: number,
  charFactor: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines: string[] = []
  let line = ''
  const widthOf = (s: string) => s.length * fontSize * charFactor
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w
    if (widthOf(candidate) <= maxWidthPx) {
      line = candidate
    } else {
      if (line) lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)
  return lines
}

function detectMime(buf: Buffer): string {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return 'image/png'
  }
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) {
    return 'image/webp'
  }
  return 'image/jpeg'
}

function toDataUrl(buf: Buffer): string {
  return `data:${detectMime(buf)};base64,${buf.toString('base64')}`
}

async function resolveBackground(
  input: Buffer | string | undefined,
): Promise<Buffer | null> {
  if (input === undefined) return null
  if (Buffer.isBuffer(input)) return input
  const resp = await fetch(input)
  if (!resp.ok) {
    throw new Error(`slide-composer: failed to fetch background image (${resp.status})`)
  }
  const ab = await resp.arrayBuffer()
  return Buffer.from(ab)
}

// ── SVG builders ──────────────────────────────────────────────

type BuiltSvg = { defs: string[]; body: string[] }

function buildBackground(
  slideNumber: number,
  spec: FormatSpec,
  bgDataUrl: string | null,
): BuiltSvg {
  const blurred = slideNumber !== 1 && slideNumber !== 8
  const defs: string[] = []
  const body: string[] = []

  defs.push(
    `<clipPath id="canvasClip"><rect x="0" y="0" width="${spec.canvasW}" height="${spec.canvasH}"/></clipPath>`,
    `<linearGradient id="bgOverlay" x1="0" y1="0" x2="0" y2="${spec.canvasH}" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0%" stop-color="${COLORS.gradientTop}"/>` +
      `<stop offset="100%" stop-color="${COLORS.gradientBottom}"/>` +
      `</linearGradient>`,
  )
  if (blurred) {
    defs.push(
      `<filter id="bgBlur" x="-10%" y="-10%" width="120%" height="120%">` +
        `<feGaussianBlur stdDeviation="10"/>` +
        `</filter>`,
    )
  }

  // Solid base fill (visible if image doesn't cover).
  body.push(
    `<rect x="0" y="0" width="${spec.canvasW}" height="${spec.canvasH}" fill="${COLORS.bg}"/>`,
  )

  if (bgDataUrl) {
    const scale = blurred ? 1.08 : 1.0
    const w = spec.canvasW * scale
    const h = spec.canvasH * scale
    const ox = (spec.canvasW - w) / 2
    const oy = (spec.canvasH - h) / 2
    const filterAttr = blurred ? ' filter="url(#bgBlur)"' : ''
    body.push(
      `<g clip-path="url(#canvasClip)">` +
        `<image href="${bgDataUrl}" x="${fmt(ox)}" y="${fmt(oy)}" width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="xMidYMid slice"${filterAttr}/>` +
        `</g>`,
    )
  } else {
    const p = PLACEHOLDER_GRADIENTS[slideNumber - 1] ?? PLACEHOLDER_GRADIENTS[0]
    const gradId = `phGrad${slideNumber}`
    defs.push(
      `<linearGradient id="${gradId}" x1="0" y1="0" x2="${spec.canvasW}" y2="${spec.canvasH}" gradientUnits="userSpaceOnUse">` +
        `<stop offset="0%" stop-color="${p.top}"/>` +
        `<stop offset="100%" stop-color="${p.bottom}"/>` +
        `</linearGradient>`,
    )
    const filterAttr = blurred ? ' filter="url(#bgBlur)"' : ''
    body.push(
      `<rect x="0" y="0" width="${spec.canvasW}" height="${spec.canvasH}" fill="url(#${gradId})"${filterAttr}/>`,
    )
  }

  // Vertical gradient overlay — sits on top of image/gradient.
  body.push(
    `<rect x="0" y="0" width="${spec.canvasW}" height="${spec.canvasH}" fill="url(#bgOverlay)"/>`,
  )

  return { defs, body }
}

function brandBlock(spec: FormatSpec): string {
  const xLeft = 60
  const yBottom = spec.canvasH - 60
  const nameSize = spec.brandNameSize
  const taglineSize = spec.brandTaglineSize
  // Two lines, tagline baseline at yBottom, brand name baseline above it.
  const taglineBaseline = yBottom
  const gap = 4
  const nameBaseline = taglineBaseline - taglineSize - gap
  return (
    `<text x="${xLeft}" y="${fmt(nameBaseline)}" fill="${COLORS.gold}" font-family="Libre Baskerville" font-size="${nameSize}" font-weight="400" text-anchor="start">Cinemagraphs</text>` +
    `<text x="${xLeft}" y="${fmt(taglineBaseline)}" fill="${COLORS.creamMuted}" font-family="DM Sans" font-size="${taglineSize}" font-weight="400" text-anchor="start">Movie reviews, visualized</text>`
  )
}

function counterText(slideNumber: number, spec: FormatSpec): string {
  const xRight = spec.canvasW - 60
  const yBaseline = spec.canvasH - 60
  const size = spec.counterSize
  const ls = size * 0.15
  const text = `${String(slideNumber).padStart(2, '0')} / 08`
  return (
    `<text x="${xRight}" y="${yBaseline}" fill="${COLORS.creamSubtle}" font-family="DM Sans" font-size="${size}" font-weight="500" letter-spacing="${fmt(ls)}" text-anchor="end">${escapeXml(text)}</text>`
  )
}

function pillText(label: string, x: number, yBaseline: number): string {
  const size = 14
  const ls = size * 0.15
  return (
    `<text x="${x}" y="${fmt(yBaseline)}" fill="${COLORS.gold}" font-family="DM Sans" font-size="${size}" font-weight="500" letter-spacing="${fmt(ls)}" text-anchor="start">${escapeXml(label.toUpperCase())}</text>`
  )
}

// Headline renders a single <text> with tspans for multi-line.
function headlineTspans(
  text: string,
  x: number,
  firstBaseline: number,
  maxWidthPx: number,
): { svg: string; lines: number; fontSize: number; lineHeight: number } {
  const size = 56
  const lineHeight = size * 1.1
  const lines = wrapText(text, maxWidthPx, size, CHAR_FACTOR_SERIF)
  const safeLines = lines.length > 0 ? lines : ['']
  const parts = safeLines.map((ln, i) =>
    `<tspan x="${x}" dy="${i === 0 ? 0 : fmt(lineHeight)}">${escapeXml(ln)}</tspan>`,
  )
  const svg =
    `<text x="${x}" y="${fmt(firstBaseline)}" fill="${COLORS.cream}" font-family="Playfair Display" font-size="${size}" font-weight="700">` +
    parts.join('') +
    `</text>`
  return { svg, lines: safeLines.length, fontSize: size, lineHeight }
}

// Body copy — plain monochrome in C1. Wraps to fit, right anchor at bodyBottom.
// TODO C2: parse {{color:text}} tokens for inline scoring colors.
function bodyCopy(text: string, spec: FormatSpec): string {
  const xLeft = 60
  const xRight = spec.canvasW - 60
  const maxWidth = xRight - xLeft
  const fontSize = spec.bodySize
  const lineHeight = fontSize * 1.5
  const lines = wrapText(text, maxWidth, fontSize, CHAR_FACTOR_SANS)
  const safeLines = lines.length > 0 ? lines : ['']
  // Last line baseline sits a small descent above bodyBottom.
  const lastBaseline = spec.canvasH - spec.bodyBottom - fontSize * 0.2
  const firstBaseline = lastBaseline - (safeLines.length - 1) * lineHeight
  const parts = safeLines.map((ln, i) =>
    `<tspan x="${xLeft}" dy="${i === 0 ? 0 : fmt(lineHeight)}">${escapeXml(ln)}</tspan>`,
  )
  return (
    `<text x="${xLeft}" y="${fmt(firstBaseline)}" fill="${COLORS.creamMuted}" font-family="DM Sans" font-size="${fontSize}" font-weight="400">` +
    parts.join('') +
    `</text>`
  )
}

// ── Slide 1: hook ─────────────────────────────────────────────

function composeHookSlide(film: FilmData, spec: FormatSpec): BuiltSvg {
  const defs: string[] = []
  const body: string[] = []

  // Pill.
  const pillBaseline = spec.topTextY + 14
  body.push(pillText('BEAT BY BEAT', 60, pillBaseline))

  // Film title — Playfair 88, max-width 88%, can wrap.
  const titleSize = 88
  const titleLineHeight = titleSize * 1.05
  const titleMaxWidth = (spec.canvasW - 120) * 0.88
  const titleLines = wrapText(film.title, titleMaxWidth, titleSize, CHAR_FACTOR_SERIF)
  const safeTitleLines = titleLines.length > 0 ? titleLines : [film.title]
  const titleFirstBaseline = pillBaseline + 16 + titleSize
  const titleParts = safeTitleLines.map((ln, i) =>
    `<tspan x="60" dy="${i === 0 ? 0 : fmt(titleLineHeight)}">${escapeXml(ln)}</tspan>`,
  )
  body.push(
    `<text x="60" y="${fmt(titleFirstBaseline)}" fill="${COLORS.cream}" font-family="Playfair Display" font-size="${titleSize}" font-weight="700">` +
      titleParts.join('') +
      `</text>`,
  )

  // Metadata — DM Sans 22, one line.
  const metaSize = 22
  const metaParts = [String(film.year), film.runtime, ...film.genres].filter(Boolean)
  const metaText = metaParts.join(' · ')
  const titleBlockBottom = titleFirstBaseline + (safeTitleLines.length - 1) * titleLineHeight
  const metaBaseline = titleBlockBottom + 20 + metaSize
  body.push(
    `<text x="60" y="${fmt(metaBaseline)}" fill="${COLORS.creamMuted}" font-family="DM Sans" font-size="${metaSize}" font-weight="400" text-anchor="start">${escapeXml(metaText)}</text>`,
  )

  // Big score — "CRITICS" label + big number, shared baseline at bottom 180.
  const scoreLabelSize = 16
  const scoreNumSize = 120
  const scoreBaseline = spec.canvasH - 180 - scoreNumSize * 0.1
  const labelLs = scoreLabelSize * 0.15
  // Approximate label width so the score number follows with a 20px gap.
  const labelText = 'CRITICS'
  const labelWidth =
    labelText.length * scoreLabelSize * CHAR_FACTOR_SANS +
    (labelText.length - 1) * labelLs
  body.push(
    `<text x="60" y="${fmt(scoreBaseline)}" fill="${COLORS.creamMuted}" font-family="DM Sans" font-size="${scoreLabelSize}" font-weight="500" letter-spacing="${fmt(labelLs)}" text-anchor="start">${escapeXml(labelText)}</text>`,
  )
  const numberX = 60 + labelWidth + 20
  body.push(
    `<text x="${fmt(numberX)}" y="${fmt(scoreBaseline)}" fill="${COLORS.gold}" font-family="Playfair Display" font-size="${scoreNumSize}" font-weight="700" text-anchor="start">${film.criticsScore.toFixed(1)}</text>`,
  )

  body.push(brandBlock(spec))
  body.push(counterText(1, spec))

  return { defs, body }
}

// ── Slides 2-7: middle ────────────────────────────────────────

function composeMiddleSlide(
  film: FilmData,
  slideNumber: number,
  content: MiddleSlideContent,
  spec: FormatSpec,
  format: '4x5' | '9x16',
): BuiltSvg {
  const defs: string[] = []
  const body: string[] = []

  // Pill + headline.
  const pillBaseline = spec.topTextY + 14
  body.push(pillText(content.pillLabel, 60, pillBaseline))

  const headlineMaxWidth = (spec.canvasW - 120) * 0.7
  const headlineFirstBaseline = pillBaseline + 16 + 56
  const headline = headlineTspans(
    content.headline,
    60,
    headlineFirstBaseline,
    headlineMaxWidth,
  )
  body.push(headline.svg)

  // Dark panel behind graph zone.
  body.push(
    `<rect x="${fmt(spec.panel.x)}" y="${fmt(spec.panel.y)}" width="${fmt(spec.panel.w)}" height="${fmt(spec.panel.h)}" fill="${COLORS.panelBg}"/>`,
  )

  // Graph render — Phase B.
  const { png: graphPng, dotPositions } = renderGraph({
    dataPoints: film.dataPoints,
    totalRuntime: film.totalRuntimeMinutes,
    criticsScore: film.criticsScore,
    width: spec.graphZone.w,
    height: spec.graphZone.h,
    format,
    highlightBeatIndex: content.highlightBeatIndex,
  })
  if (
    content.highlightBeatIndex < 0 ||
    content.highlightBeatIndex >= dotPositions.length
  ) {
    throw new Error(
      `slide-composer: highlightBeatIndex ${content.highlightBeatIndex} is out of range (0..${dotPositions.length - 1})`,
    )
  }
  const graphDataUrl = toDataUrl(graphPng)
  body.push(
    `<image href="${graphDataUrl}" x="${fmt(spec.graphZone.x)}" y="${fmt(spec.graphZone.y)}" width="${fmt(spec.graphZone.w)}" height="${fmt(spec.graphZone.h)}" preserveAspectRatio="xMidYMid meet"/>`,
  )

  // Inline beat label — anchored off the highlighted dot position.
  const dot = dotPositions[content.highlightBeatIndex]
  const labelX = spec.graphZone.x + dot.x + 12
  const labelY = spec.graphZone.y + dot.y - 8
  const labelColor = DOT_COLOR_HEX[dot.color]
  const labelSize = spec.beatLabelSize
  body.push(
    `<text x="${fmt(labelX)}" y="${fmt(labelY)}" fill="${labelColor}" font-family="DM Sans" font-size="${labelSize}" font-weight="500" text-anchor="start">${dot.score.toFixed(1)}</text>`,
  )

  // Body copy (plain monochrome in C1).
  body.push(bodyCopy(content.bodyCopy, spec))

  body.push(brandBlock(spec))
  body.push(counterText(slideNumber, spec))

  return { defs, body }
}

// ── Slide 8: takeaway ─────────────────────────────────────────

function composeTakeawaySlide(film: FilmData, spec: FormatSpec): BuiltSvg {
  const defs: string[] = []
  const body: string[] = []

  // Stack items with their heights and margin-bottoms.
  const miniW = 240
  const miniH = 80
  const items: { kind: string; height: number; marginBottom: number }[] = [
    { kind: 'number', height: 140, marginBottom: 24 },
    { kind: 'italic', height: 48, marginBottom: 32 }, // 40 * 1.2
    { kind: 'rule', height: 1, marginBottom: 32 },
    { kind: 'uppercase', height: 24, marginBottom: 32 }, // 20 * 1.2
    { kind: 'mini', height: miniH, marginBottom: 48 },
    { kind: 'brand', height: 38, marginBottom: 12 }, // 32 * 1.2
    { kind: 'tagline', height: 20, marginBottom: 0 }, // 16 * 1.25
  ]
  const stackHeight = items.reduce((acc, it) => acc + it.height + it.marginBottom, 0)
  const stackTop = (spec.canvasH - stackHeight) / 2
  const centerX = spec.canvasW / 2

  let cursor = stackTop
  for (const item of items) {
    if (item.kind === 'number') {
      // 140 Playfair gold, centered. Baseline = top + fontSize.
      const baseline = cursor + 140
      body.push(
        `<text x="${fmt(centerX)}" y="${fmt(baseline)}" fill="${COLORS.gold}" font-family="Playfair Display" font-size="140" font-weight="700" text-anchor="middle">${film.criticsScore.toFixed(1)}</text>`,
      )
    } else if (item.kind === 'italic') {
      const baseline = cursor + 40
      body.push(
        `<text x="${fmt(centerX)}" y="${fmt(baseline)}" fill="${COLORS.cream}" font-family="Playfair Display" font-size="40" font-weight="700" font-style="italic" text-anchor="middle">doesn&apos;t tell this story.</text>`,
      )
    } else if (item.kind === 'rule') {
      const ruleW = 60
      body.push(
        `<rect x="${fmt(centerX - ruleW / 2)}" y="${fmt(cursor)}" width="${ruleW}" height="1" fill="${COLORS.creamMuted}"/>`,
      )
    } else if (item.kind === 'uppercase') {
      const size = 20
      const ls = size * 0.15
      const baseline = cursor + size
      body.push(
        `<text x="${fmt(centerX)}" y="${fmt(baseline)}" fill="${COLORS.cream}" font-family="DM Sans" font-size="${size}" font-weight="500" letter-spacing="${fmt(ls)}" text-anchor="middle">THE GRAPH DOES.</text>`,
      )
    } else if (item.kind === 'mini') {
      const { png: miniPng } = renderGraph({
        dataPoints: film.dataPoints,
        totalRuntime: film.totalRuntimeMinutes,
        criticsScore: film.criticsScore,
        width: miniW,
        height: miniH,
        format: '4x5',
        highlightBeatIndex: undefined,
        minimal: true,
      })
      const miniDataUrl = toDataUrl(miniPng)
      body.push(
        `<image href="${miniDataUrl}" x="${fmt(centerX - miniW / 2)}" y="${fmt(cursor)}" width="${miniW}" height="${miniH}" preserveAspectRatio="xMidYMid meet"/>`,
      )
    } else if (item.kind === 'brand') {
      const baseline = cursor + 32
      body.push(
        `<text x="${fmt(centerX)}" y="${fmt(baseline)}" fill="${COLORS.gold}" font-family="Libre Baskerville" font-size="32" font-weight="400" text-anchor="middle">cinemagraphs.ca</text>`,
      )
    } else if (item.kind === 'tagline') {
      const baseline = cursor + 16
      body.push(
        `<text x="${fmt(centerX)}" y="${fmt(baseline)}" fill="${COLORS.creamSubtle}" font-family="DM Sans" font-size="16" font-weight="400" text-anchor="middle">Every film. Every beat. Visualized.</text>`,
      )
    }
    cursor += item.height + item.marginBottom
  }

  // Intentionally reference film.title to keep the API consistent (hardcoded chrome
  // does not render it; parameter is accepted for future use).
  void film.title

  return { defs, body }
}

// ── Public entry ──────────────────────────────────────────────

export async function composeSlide(input: ComposeSlideInput): Promise<Buffer> {
  const { film, slideNumber, format, middleContent, backgroundImage } = input

  if (slideNumber >= 2 && slideNumber <= 7) {
    if (!middleContent) {
      throw new Error(
        `slide-composer: middleContent is required for slide ${slideNumber} (slides 2-7 must supply pill, headline, body, and highlightBeatIndex)`,
      )
    }
    // We validate highlightBeatIndex against the final dotPositions length
    // once renderGraph returns; at entry we only pre-check against the
    // post-anchor expected length.
    const expectedLen = film.dataPoints.length + 1
    if (
      !Number.isInteger(middleContent.highlightBeatIndex) ||
      middleContent.highlightBeatIndex < 0 ||
      middleContent.highlightBeatIndex >= expectedLen
    ) {
      throw new Error(
        `slide-composer: middleContent.highlightBeatIndex ${middleContent.highlightBeatIndex} is out of range (0..${expectedLen - 1})`,
      )
    }
  }

  const spec = specFor(format)
  const bgBuf = await resolveBackground(backgroundImage)
  const bgDataUrl = bgBuf ? toDataUrl(bgBuf) : null

  const bg = buildBackground(slideNumber, spec, bgDataUrl)
  let content: BuiltSvg
  if (slideNumber === 1) {
    content = composeHookSlide(film, spec)
  } else if (slideNumber === 8) {
    content = composeTakeawaySlide(film, spec)
  } else {
    content = composeMiddleSlide(film, slideNumber, middleContent!, spec, format)
  }

  const defs = [...bg.defs, ...content.defs].join('')
  const bodyStr = [...bg.body, ...content.body].join('')
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.canvasW}" height="${spec.canvasH}" viewBox="0 0 ${spec.canvasW} ${spec.canvasH}">` +
    `<defs>${defs}</defs>` +
    bodyStr +
    `</svg>`

  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontFiles: FONT_FILES,
      defaultFontFamily: 'DM Sans',
    },
  })
  return resvg.render().asPng()
}
