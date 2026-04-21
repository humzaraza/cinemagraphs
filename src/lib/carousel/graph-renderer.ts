import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { area as d3Area, curveMonotoneX, line as d3Line } from 'd3-shape'

export type DataPoint = { t: number; s: number }
export type Format = '4x5' | '9x16'

export type RenderGraphInput = {
  dataPoints: DataPoint[]
  totalRuntime: number
  criticsScore: number
  width: number
  height: number
  format: Format
  highlightBeatIndex?: number
  minimal?: boolean
}

export type DotPosition = {
  x: number
  y: number
  score: number
  color: 'red' | 'gold' | 'teal'
  timestamp: number
}

export type RenderGraphOutput = {
  svg: string
  png: Buffer
  dotPositions: DotPosition[]
}

// ── Font loading (cached at module scope) ─────────────────────
// @fontsource/dm-sans only ships WOFF/WOFF2, which resvg-js 2.6.2 does not load.
// Using @expo-google-fonts/dm-sans which ships TTFs compatible with resvg.
// Paths are built from process.cwd() so Turbopack doesn't try to bundle the TTF as a module.
const NODE_MODULES = join(process.cwd(), 'node_modules')
const DM_SANS_400_PATH = join(NODE_MODULES, '@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf')
const DM_SANS_500_PATH = join(NODE_MODULES, '@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf')
// Touch files at load so a missing font surfaces before first render.
readFileSync(DM_SANS_400_PATH)
readFileSync(DM_SANS_500_PATH)

// ── Pure helpers ──────────────────────────────────────────────

export function computeYRange(scores: number[]): { yMin: number; yMax: number } {
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const yMin = Math.max(1, Math.floor(min) - 1)
  const yMax = Math.min(10, Math.ceil(max) + 1)
  return { yMin, yMax }
}

export function computeDotColor(score: number): 'red' | 'gold' | 'teal' {
  if (score < 6) return 'red'
  if (score < 8) return 'gold'
  return 'teal'
}

export function prependNeutralAnchor(points: DataPoint[]): DataPoint[] {
  if (points.length > 0 && points[0].t === 0 && points[0].s === 5.0) {
    return points
  }
  return [{ t: 0, s: 5.0 }, ...points]
}

// ── Colors / constants ────────────────────────────────────────

const DOT_FILL = {
  red: '#E05555',
  gold: '#C8A951',
  teal: '#2DD4A8',
} as const

const MAIN_LINE = '#C8A951'
const GLOW_LINE = 'rgba(200,169,81,0.2)'
const DOT_OUTLINE = 'rgba(0,0,0,0.6)'
const LABEL_COLOR = 'rgba(232,228,220,0.5)'
const VALUE_COLOR = '#C8A951'

type Margins = { left: number; right: number; top: number; bottom: number }

function marginsFor(format: Format): Margins {
  if (format === '4x5') {
    return { left: 30, right: 30, top: 60, bottom: 30 }
  }
  return { left: 40, right: 40, top: 110, bottom: 40 }
}

function dotRadiusFor(format: Format): number {
  return format === '4x5' ? 5 : 7
}

// ── Main ──────────────────────────────────────────────────────

export function renderGraph(input: RenderGraphInput): RenderGraphOutput {
  const { svg, dotPositions } = buildSvg(input)
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontFiles: [DM_SANS_400_PATH, DM_SANS_500_PATH],
      defaultFontFamily: 'DM Sans',
    },
  })
  const png = resvg.render().asPng()
  return { svg, png, dotPositions }
}

function buildSvg(input: RenderGraphInput): { svg: string; dotPositions: DotPosition[] } {
  const { totalRuntime, criticsScore, width, height, format, highlightBeatIndex, minimal } = input
  const points = prependNeutralAnchor(input.dataPoints)
  const margins = minimal
    ? { left: 4, right: 4, top: 4, bottom: 4 }
    : marginsFor(format)
  const dotRadius = dotRadiusFor(format)

  const plotW = width - margins.left - margins.right
  const plotH = height - margins.top - margins.bottom
  const plotBottom = margins.top + plotH

  const { yMin, yMax } = computeYRange(points.map((p) => p.s))
  const ySpan = yMax - yMin

  const sX = (t: number) => margins.left + (t / totalRuntime) * plotW
  const sY = (s: number) => margins.top + ((yMax - s) / ySpan) * plotH

  const lineGen = d3Line<DataPoint>()
    .x((p) => sX(p.t))
    .y((p) => sY(p.s))
    .curve(curveMonotoneX)
  const areaGen = d3Area<DataPoint>()
    .x((p) => sX(p.t))
    .y0(plotBottom)
    .y1((p) => sY(p.s))
    .curve(curveMonotoneX)

  const lineD = lineGen(points) ?? ''
  const areaD = areaGen(points) ?? ''

  const highlighted =
    highlightBeatIndex !== undefined &&
    highlightBeatIndex >= 0 &&
    highlightBeatIndex < points.length
  const hlPoint = highlighted ? points[highlightBeatIndex!] : null
  const hlX = hlPoint ? sX(hlPoint.t) : 0
  const hlY = hlPoint ? sY(hlPoint.s) : 0

  // ── <defs> ────────────────────────────────────────────────
  const defs: string[] = []
  defs.push(
    `<linearGradient id="areaGrad" x1="0" y1="${margins.top}" x2="0" y2="${plotBottom}" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0%" stop-color="rgba(200,169,81,0.18)"/>` +
      `<stop offset="60%" stop-color="rgba(200,169,81,0.04)"/>` +
      `<stop offset="100%" stop-color="rgba(200,169,81,0)"/>` +
      `</linearGradient>`,
  )
  if (highlighted) {
    defs.push(
      `<filter id="peakGlow" x="-100%" y="-100%" width="300%" height="300%">` +
        `<feGaussianBlur stdDeviation="8"/>` +
        `</filter>`,
    )
    const maskRadius = format === '4x5' ? 90 : 120
    defs.push(
      `<mask id="hlMask-${format}">` +
        `<radialGradient id="hlGrad-${format}" cx="${fmt(hlX)}" cy="${fmt(hlY)}" r="${maskRadius}" gradientUnits="userSpaceOnUse">` +
          `<stop offset="0%" stop-color="white" stop-opacity="1"/>` +
          `<stop offset="60%" stop-color="white" stop-opacity="1"/>` +
          `<stop offset="100%" stop-color="white" stop-opacity="0"/>` +
          `</radialGradient>` +
        `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#hlGrad-${format})"/>` +
        `</mask>`,
    )
  }

  // ── body ──────────────────────────────────────────────────
  const curveBody =
    `<path d="${areaD}" fill="url(#areaGrad)"/>` +
    `<path d="${lineD}" stroke="${GLOW_LINE}" stroke-width="9" stroke-linecap="round" fill="none"/>` +
    `<path d="${lineD}" stroke="${MAIN_LINE}" stroke-width="4" fill="none"/>`

  const body: string[] = []
  if (highlighted) {
    body.push(`<g opacity="0.22">${curveBody}</g>`)
    body.push(`<g mask="url(#hlMask-${format})">${curveBody}</g>`)
  } else {
    body.push(curveBody)
  }

  const baseOpacityFor = (idx: number): number => {
    if (!highlighted) return 1
    return idx === highlightBeatIndex ? 1 : 0.4
  }

  const dotPositions: DotPosition[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const cx = sX(p.t)
    const cy = sY(p.s)
    const colorKey = computeDotColor(p.s)
    const fill = DOT_FILL[colorKey]
    const baseOp = baseOpacityFor(i)
    const haloOp = 0.3 * baseOp

    dotPositions.push({
      x: cx,
      y: cy,
      score: p.s,
      color: colorKey,
      timestamp: p.t,
    })

    if (highlighted && i === highlightBeatIndex) {
      body.push(
        `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${dotRadius + 8}" fill="${fill}" opacity="0.6" filter="url(#peakGlow)"/>`,
      )
    }
    body.push(
      `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${dotRadius + 3}" fill="${fill}" opacity="${fmt(haloOp)}"/>`,
    )
    body.push(
      `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${dotRadius}" fill="${fill}" stroke="${DOT_OUTLINE}" stroke-width="1.5" opacity="${fmt(baseOp)}"/>`,
    )
  }

  // ── score text ────────────────────────────────────────────
  if (!minimal) {
    const valueText = criticsScore.toFixed(1)
    // Collision detection: if any curve point falls within the default score
    // bounding box, move to the opposite corner. If both collide, fall back
    // to the default (keeps behavior stable rather than failing closed).
    type Box = { xMin: number; xMax: number; yMin: number; yMax: number }
    const defaultBox: Box = format === '4x5'
      ? { xMin: width - 180, xMax: width - 20, yMin: 10, yMax: 90 }
      : { xMin: 20, xMax: 280, yMin: 20, yMax: 120 }
    const oppositeBox: Box = format === '4x5'
      ? { xMin: 20, xMax: 180, yMin: 10, yMax: 90 }
      : { xMin: width - 280, xMax: width - 20, yMin: 20, yMax: 120 }
    const collides = (box: Box) =>
      points.some((p) => {
        const px = sX(p.t)
        const py = sY(p.s)
        return px >= box.xMin && px <= box.xMax && py >= box.yMin && py <= box.yMax
      })
    const useOpposite = collides(defaultBox) && !collides(oppositeBox)

    if (format === '4x5') {
      const x = useOpposite ? 100 : width - 60
      body.push(
        `<text x="${x}" y="20" fill="${LABEL_COLOR}" font-family="DM Sans" font-size="13" font-weight="400" text-anchor="middle">Critics</text>`,
      )
      body.push(
        `<text x="${x}" y="56" fill="${VALUE_COLOR}" font-family="DM Sans" font-size="38" font-weight="500" text-anchor="middle">${valueText}</text>`,
      )
    } else {
      const x = useOpposite ? width - 54 : 54
      const anchor = useOpposite ? 'end' : 'start'
      body.push(
        `<text x="${x}" y="40" fill="${LABEL_COLOR}" font-family="DM Sans" font-size="18" font-weight="400" text-anchor="${anchor}">Critics</text>`,
      )
      body.push(
        `<text x="${x}" y="92" fill="${VALUE_COLOR}" font-family="DM Sans" font-size="56" font-weight="500" text-anchor="${anchor}">${valueText}</text>`,
      )
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>${defs.join('')}</defs>` +
    body.join('') +
    `</svg>`

  return { svg, dotPositions }
}

function fmt(n: number): string {
  return Number.isFinite(n) ? (+n.toFixed(3)).toString() : '0'
}
