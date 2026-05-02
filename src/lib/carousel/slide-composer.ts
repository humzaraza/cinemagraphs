import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

import { fetchTmdbImageAsBuffer } from '@/lib/tmdb-image'
import { dotRadiusFor, marginsFor, renderGraph, type DataPoint } from './graph-renderer'
import { makePolylineSampler, type SamplerPoint } from './polyline-sampler'

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
  bodyText: '#F5F5F5',
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

export type FormatSpec = {
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
  pillSize: number
  // Headline size varies by format; the headline is the serif line under the
  // pill on slides 2-7. Kept alongside pillSize so the two can be tuned
  // together when the format changes.
  headlineSize: number
  miniGraph: { w: number; h: number }
}

export function specFor(format: '4x5' | '9x16'): FormatSpec {
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
      bodyBottom: 260,
      brandNameSize: 20,
      brandTaglineSize: 13,
      counterSize: 14,
      bodySize: 28,
      beatLabelSize: 28,
      pillSize: 22,
      headlineSize: 44,
      miniGraph: { w: 800, h: 160 },
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
    bodyBottom: 280,
    brandNameSize: 24,
    brandTaglineSize: 15,
    counterSize: 16,
    bodySize: 35,
    beatLabelSize: 36,
    pillSize: 28,
    headlineSize: 56,
    miniGraph: { w: 900, h: 180 },
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

// ── Body copy color tokens ────────────────────────────────────
// Body copy may contain {{color:value}} markers produced by the LLM,
// e.g. "The score hits {{teal:9.5}}." The renderer parses these into
// colored segments and emits <tspan>s so the inline number picks up
// the dot color, tying the copy visually to the graph.

export type BodyCopyColor = 'red' | 'gold' | 'teal'
export type BodyCopySegment = { text: string; color: BodyCopyColor | null }

export class BodyCopyParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BodyCopyParseError'
  }
}

export function parseBodyCopyTokens(text: string): BodyCopySegment[] {
  const segments: BodyCopySegment[] = []
  let buffer = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2)
      if (end === -1) {
        throw new BodyCopyParseError(
          `Unterminated color marker in body copy at index ${i}: "${text}"`,
        )
      }
      const inner = text.slice(i + 2, end)
      const colonIdx = inner.indexOf(':')
      if (colonIdx === -1) {
        throw new BodyCopyParseError(
          `Missing colon in color marker: "${text.slice(i, end + 2)}"`,
        )
      }
      const rawColor = inner.slice(0, colonIdx)
      const value = inner.slice(colonIdx + 1)
      if (rawColor !== 'red' && rawColor !== 'gold' && rawColor !== 'teal') {
        throw new BodyCopyParseError(
          `Invalid color "${rawColor}" in marker: "${text.slice(i, end + 2)}" (allowed: red, gold, teal)`,
        )
      }
      const color = rawColor as BodyCopyColor
      if (value.length === 0) {
        throw new BodyCopyParseError(
          `Empty value in color marker: "${text.slice(i, end + 2)}"`,
        )
      }
      if (buffer.length > 0) {
        segments.push({ text: buffer, color: null })
        buffer = ''
      }
      segments.push({ text: value, color })
      i = end + 2
    } else {
      buffer += text[i]
      i++
    }
  }
  if (buffer.length > 0) {
    segments.push({ text: buffer, color: null })
  }
  return segments
}

type ColorRun = { text: string; color: BodyCopyColor | null }
type ColoredWord = { runs: ColorRun[]; textLength: number }

function segmentsToColoredWords(segments: BodyCopySegment[]): ColoredWord[] {
  const words: ColoredWord[] = []
  let currentRuns: ColorRun[] = []
  let currentTextLen = 0
  const flushWord = () => {
    if (currentRuns.length > 0) {
      words.push({ runs: currentRuns, textLength: currentTextLen })
      currentRuns = []
      currentTextLen = 0
    }
  }
  for (const seg of segments) {
    for (const ch of seg.text) {
      if (/\s/.test(ch)) {
        flushWord()
      } else {
        const last = currentRuns[currentRuns.length - 1]
        if (last && last.color === seg.color) {
          last.text += ch
        } else {
          currentRuns.push({ text: ch, color: seg.color })
        }
        currentTextLen += 1
      }
    }
  }
  flushWord()
  return words
}

function wrapColoredWords(
  words: ColoredWord[],
  maxWidthPx: number,
  fontSize: number,
  charFactor: number,
): ColoredWord[][] {
  if (words.length === 0) return []
  const lines: ColoredWord[][] = []
  let line: ColoredWord[] = []
  let lineChars = 0
  const maxChars = maxWidthPx / (fontSize * charFactor)
  for (const w of words) {
    const gap = line.length > 0 ? 1 : 0
    if (lineChars + gap + w.textLength <= maxChars) {
      line.push(w)
      lineChars += gap + w.textLength
    } else {
      if (line.length > 0) lines.push(line)
      line = [w]
      lineChars = w.textLength
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}

// ── Score label positioning ───────────────────────────────────
// Places the inline beat score next to the highlighted dot so the
// text never sits on top of the polyline. Strategy: try 8 candidate
// positions arranged around the dot at 45° spacing; for each, sample
// the rendered polyline inside the candidate's bounding box and pick
// the position with the most vertical clearance. If nothing clears
// the threshold at the default offset, expand the offset in 12 px
// steps up to 60 px and re-evaluate.
//
// Candidates that would push the score off the inner plot area are
// rejected. If every candidate at every offset is out-of-bounds
// (extremely unlikely in practice), we fall back to the highest
// clearance position regardless of bounds.

// Estimated character-to-pixel-width ratio for DM Sans 500 digits.
// Matches what the rest of the file uses for wrap math (0.52-0.55
// range); we use 0.55 here to be slightly generous so the collision
// bbox overestimates rather than underestimates width.
const SCORE_CHAR_FACTOR = 0.55

// SVG baseline offset from the visual bottom of the bounding box,
// as a fraction of labelSize. Matches typographic cap-height /
// descender conventions for DM Sans digits ("0"-"9", ".").
const BASELINE_FROM_BOTTOM = 0.15

// Threshold for "acceptable" clearance: the polyline must stay at
// least this many pixels outside the label's bounding box for a
// candidate to be accepted without expanding the offset.
const CLEARANCE_THRESHOLD = 8

// Offset ladder (added to dotRadius). Smaller offsets are tried
// first; the loop exits as soon as an offset level has an in-bounds
// candidate with clearance >= CLEARANCE_THRESHOLD.
const OFFSET_LADDER = [12, 24, 36, 48, 60] as const

// Number of X samples per candidate bbox used to measure clearance.
const CLEARANCE_SAMPLES = 8

type CandidateShape = {
  angleDeg: number
  anchor: 'start' | 'middle' | 'end'
  cosA: number
  sinA: number
  xShift: -1 | 0 | 1 // bbox center X relative to "nearest point" (dot + R*direction)
  yShift: -1 | 0 | 1 // bbox center Y relative to "nearest point" (SVG y convention)
}

const S = Math.SQRT1_2
const CANDIDATES: CandidateShape[] = [
  { angleDeg: 0, anchor: 'start', cosA: 1, sinA: 0, xShift: 1, yShift: 0 },
  { angleDeg: 45, anchor: 'start', cosA: S, sinA: S, xShift: 1, yShift: -1 },
  { angleDeg: 90, anchor: 'middle', cosA: 0, sinA: 1, xShift: 0, yShift: -1 },
  { angleDeg: 135, anchor: 'end', cosA: -S, sinA: S, xShift: -1, yShift: -1 },
  { angleDeg: 180, anchor: 'end', cosA: -1, sinA: 0, xShift: -1, yShift: 0 },
  { angleDeg: 225, anchor: 'end', cosA: -S, sinA: -S, xShift: -1, yShift: 1 },
  { angleDeg: 270, anchor: 'middle', cosA: 0, sinA: -1, xShift: 0, yShift: 1 },
  { angleDeg: 315, anchor: 'start', cosA: S, sinA: -S, xShift: 1, yShift: 1 },
]

export type Bbox = { xMin: number; xMax: number; yMin: number; yMax: number }

export type ScoreLabelPositionInput = {
  dot: { x: number; y: number }
  // All dot pixel positions in graph-local coordinates, including the
  // prepended neutral anchor at index 0. Used to reconstruct the
  // polyline for clearance sampling.
  dotPositions: SamplerPoint[]
  // Rectangular area (graph-local coords) the label bbox must stay
  // inside. Typically the post-margin inner plot area of the graph.
  innerPlotArea: { x: number; y: number; width: number; height: number }
  dotRadius: number
  labelSize: number
  // Approximate pixel width of the rendered score text (e.g. "8.7").
  // Caller pre-computes from character count × labelSize × factor.
  labelWidth: number
}

export type ScoreLabelPosition = {
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
  // Gap between the polyline and the nearest bbox edge (positive =
  // clear; negative = polyline intrudes). Infinity if no sample was
  // within the dot X range.
  clearance: number
  // Which of the 8 candidate angles was chosen, and at what offset
  // distance (dotRadius + offset). Exposed for test logging so we
  // can tune the ladder without re-instrumenting the picker.
  candidateAngleDeg: number
  offsetDistance: number
  bbox: Bbox
}

export function computeLabelWidth(scoreText: string, labelSize: number): number {
  return scoreText.length * labelSize * SCORE_CHAR_FACTOR
}

function computeBbox(
  dot: { x: number; y: number },
  r: number,
  w: number,
  h: number,
  cand: CandidateShape,
): Bbox {
  const nearestX = dot.x + r * cand.cosA
  const nearestY = dot.y - r * cand.sinA
  const centerX = nearestX + cand.xShift * (w / 2)
  const centerY = nearestY + cand.yShift * (h / 2)
  return {
    xMin: centerX - w / 2,
    xMax: centerX + w / 2,
    yMin: centerY - h / 2,
    yMax: centerY + h / 2,
  }
}

function bboxInBounds(
  bbox: Bbox,
  inner: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    bbox.xMin >= inner.x &&
    bbox.xMax <= inner.x + inner.width &&
    bbox.yMin >= inner.y &&
    bbox.yMax <= inner.y + inner.height
  )
}

// Clearance = minimum (signed) gap between the polyline and the bbox
// at any of the sampled X positions. Positive when the polyline is
// fully clear of the bbox; zero or negative when it crosses.
function measureClearance(
  bbox: Bbox,
  sampler: (x: number) => number | null,
): number {
  const centerY = (bbox.yMin + bbox.yMax) / 2
  const halfH = (bbox.yMax - bbox.yMin) / 2
  let minDist = Infinity
  let anyValid = false
  for (let i = 0; i < CLEARANCE_SAMPLES; i++) {
    const t = i / (CLEARANCE_SAMPLES - 1)
    const x = bbox.xMin + t * (bbox.xMax - bbox.xMin)
    const y = sampler(x)
    if (y === null) continue
    anyValid = true
    const d = Math.abs(y - centerY)
    if (d < minDist) minDist = d
  }
  if (!anyValid) return Infinity
  return minDist - halfH
}

function renderPosition(
  cand: CandidateShape,
  bbox: Bbox,
  labelSize: number,
): { x: number; y: number; anchor: 'start' | 'middle' | 'end' } {
  const baselineY = bbox.yMax - BASELINE_FROM_BOTTOM * labelSize
  let x: number
  if (cand.anchor === 'start') x = bbox.xMin
  else if (cand.anchor === 'end') x = bbox.xMax
  else x = (bbox.xMin + bbox.xMax) / 2
  return { x, y: baselineY, anchor: cand.anchor }
}

export function computeScoreLabelPosition(
  input: ScoreLabelPositionInput,
): ScoreLabelPosition {
  const { dot, dotPositions, innerPlotArea, dotRadius, labelSize, labelWidth } = input
  const labelHeight = labelSize
  const sampler = makePolylineSampler(dotPositions)

  type Eval = {
    cand: CandidateShape
    bbox: Bbox
    inBounds: boolean
    clearance: number
    offsetDistance: number
  }
  let bestInBounds: Eval | null = null
  let bestAnywhere: Eval | null = null

  for (const offsetDistance of OFFSET_LADDER) {
    const r = dotRadius + offsetDistance
    let bestAtOffset: Eval | null = null
    for (const cand of CANDIDATES) {
      const bbox = computeBbox(dot, r, labelWidth, labelHeight, cand)
      const inBounds = bboxInBounds(bbox, innerPlotArea)
      const clearance = measureClearance(bbox, sampler)
      const e: Eval = { cand, bbox, inBounds, clearance, offsetDistance }
      if (!bestAnywhere || e.clearance > bestAnywhere.clearance) {
        bestAnywhere = e
      }
      if (!inBounds) continue
      if (!bestAtOffset || e.clearance > bestAtOffset.clearance) {
        bestAtOffset = e
      }
    }
    if (bestAtOffset) {
      if (!bestInBounds || bestAtOffset.clearance > bestInBounds.clearance) {
        bestInBounds = bestAtOffset
      }
      if (bestAtOffset.clearance >= CLEARANCE_THRESHOLD) {
        // Acceptable at this offset level — stop expanding.
        const pos = renderPosition(bestAtOffset.cand, bestAtOffset.bbox, labelSize)
        return {
          ...pos,
          clearance: bestAtOffset.clearance,
          candidateAngleDeg: bestAtOffset.cand.angleDeg,
          offsetDistance: bestAtOffset.offsetDistance,
          bbox: bestAtOffset.bbox,
        }
      }
    }
  }

  const chosen = bestInBounds ?? bestAnywhere
  // bestAnywhere is guaranteed set after the first iteration (one
  // candidate evaluated), so `chosen` is non-null here; the fallback
  // is purely defensive.
  if (!chosen) {
    throw new Error(
      'computeScoreLabelPosition: no candidate evaluated (dotPositions empty?)',
    )
  }
  const pos = renderPosition(chosen.cand, chosen.bbox, labelSize)
  return {
    ...pos,
    clearance: chosen.clearance,
    candidateAngleDeg: chosen.cand.angleDeg,
    offsetDistance: chosen.offsetDistance,
    bbox: chosen.bbox,
  }
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

  // TMDB serves WebP/AVIF via Cloudflare content negotiation. Resvg 2.6.2
  // silently drops <image> hrefs whose data is WebP/AVIF, leaving slides with
  // a dark base fill where the backdrop should appear. Route TMDB URLs
  // through the shared helper so bytes arrive as JPEG/PNG/SVG (formats Resvg
  // supports) before they reach the SVG.
  let isTmdbImage = false
  try {
    isTmdbImage = new URL(input).hostname === 'image.tmdb.org'
  } catch {
    // Not a parseable URL — fall through to the bare fetch path, which will
    // throw on invalid input the same way it always has.
  }
  if (isTmdbImage) {
    return fetchTmdbImageAsBuffer(input)
  }

  const resp = await fetch(input)
  if (!resp.ok) {
    throw new Error(`slide-composer: failed to fetch background image (${resp.status})`)
  }
  const ab = await resp.arrayBuffer()
  return Buffer.from(ab)
}

// ── SVG builders ──────────────────────────────────────────────

type BuiltSvg = { defs: string[]; body: string[] }

export function buildBackground(
  slideNumber: number,
  spec: FormatSpec,
  bgDataUrl: string | null,
): BuiltSvg {
  const blurred = slideNumber !== 1 && slideNumber !== 8
  const isBookend = slideNumber === 1 || slideNumber === 8
  const defs: string[] = []
  const body: string[] = []

  defs.push(
    `<clipPath id="canvasClip"><rect x="0" y="0" width="${spec.canvasW}" height="${spec.canvasH}"/></clipPath>`,
    `<linearGradient id="bgOverlay" x1="0" y1="0" x2="0" y2="${spec.canvasH}" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0%" stop-color="${COLORS.gradientTop}"/>` +
      `<stop offset="100%" stop-color="${COLORS.gradientBottom}"/>` +
      `</linearGradient>`,
  )
  if (isBookend) {
    defs.push(
      `<linearGradient id="coverCloserScrim" x1="0" y1="0" x2="0" y2="${spec.canvasH}" gradientUnits="userSpaceOnUse">` +
        `<stop offset="0%" stop-color="#000000" stop-opacity="0.35"/>` +
        `<stop offset="30%" stop-color="#000000" stop-opacity="0"/>` +
        `<stop offset="65%" stop-color="#000000" stop-opacity="0"/>` +
        `<stop offset="100%" stop-color="#000000" stop-opacity="0.35"/>` +
        `</linearGradient>`,
    )
  }
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

  if (isBookend) {
    body.push(
      `<rect x="0" y="0" width="${spec.canvasW}" height="${spec.canvasH}" fill="url(#coverCloserScrim)"/>`,
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

function pillText(label: string, x: number, yBaseline: number, spec: FormatSpec): string {
  const size = spec.pillSize
  const ls = size * 0.15
  return (
    `<text x="${x}" y="${fmt(yBaseline)}" fill="${COLORS.gold}" font-family="DM Sans" font-size="${size}" font-weight="500" letter-spacing="${fmt(ls)}" text-anchor="start">${escapeXml(label.toUpperCase())}</text>`
  )
}

// Headline renders a single <text> with tspans for multi-line. `size` is the
// format-specific font size supplied by the caller (see FormatSpec.headlineSize).
function headlineTspans(
  text: string,
  x: number,
  firstBaseline: number,
  maxWidthPx: number,
  size: number,
): { svg: string; lines: number; fontSize: number; lineHeight: number } {
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

// Body copy — supports inline {{color:value}} markers. Values wrapped in a
// color marker render with the matching dot color; surrounding text uses
// the muted cream default. See parseBodyCopyTokens for syntax.
function bodyCopy(text: string, spec: FormatSpec): string {
  const xLeft = 60
  const xRight = spec.canvasW - 60
  const maxWidth = xRight - xLeft
  const fontSize = spec.bodySize
  const lineHeight = fontSize * 1.65

  const segments = parseBodyCopyTokens(text)
  const words = segmentsToColoredWords(segments)
  const wrapped = wrapColoredWords(words, maxWidth, fontSize, CHAR_FACTOR_SANS)
  const lines = wrapped.length > 0 ? wrapped : [[]]

  const lastBaseline = spec.canvasH - spec.bodyBottom - fontSize * 0.2
  const firstBaseline = lastBaseline - (lines.length - 1) * lineHeight

  const colorHex: Record<BodyCopyColor, string> = {
    red: COLORS.red,
    gold: COLORS.gold,
    teal: COLORS.teal,
  }

  const parts: string[] = []
  lines.forEach((line, lineIdx) => {
    if (line.length === 0) {
      parts.push(
        `<tspan x="${xLeft}" dy="${lineIdx === 0 ? '0' : fmt(lineHeight)}"></tspan>`,
      )
      return
    }
    line.forEach((word, wordIdx) => {
      word.runs.forEach((run, runIdx) => {
        const attrs: string[] = []
        let runText = run.text
        if (wordIdx === 0 && runIdx === 0) {
          attrs.push(`x="${xLeft}"`)
          attrs.push(`dy="${lineIdx === 0 ? '0' : fmt(lineHeight)}"`)
        } else if (wordIdx > 0 && runIdx === 0) {
          runText = ' ' + runText
        }
        if (run.color) {
          attrs.push(`fill="${colorHex[run.color]}"`)
        }
        const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : ''
        parts.push(`<tspan${attrStr}>${escapeXml(runText)}</tspan>`)
      })
    })
  })

  return (
    `<text x="${xLeft}" y="${fmt(firstBaseline)}" fill="${COLORS.bodyText}" font-family="DM Sans" font-size="${fontSize}" font-weight="400">` +
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
  body.push(pillText('BEAT BY BEAT', 60, pillBaseline, spec))

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
  body.push(pillText(content.pillLabel, 60, pillBaseline, spec))

  const headlineMaxWidth = (spec.canvasW - 120) * 0.7
  const headlineFirstBaseline = pillBaseline + 16 + spec.headlineSize
  const headline = headlineTspans(
    content.headline,
    60,
    headlineFirstBaseline,
    headlineMaxWidth,
    spec.headlineSize,
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

  const dot = dotPositions[content.highlightBeatIndex]
  const labelColor = DOT_COLOR_HEX[dot.color]
  const labelSize = spec.beatLabelSize
  const scoreText = dot.score.toFixed(1)
  const margins = marginsFor(format)
  const pos = computeScoreLabelPosition({
    dot: { x: dot.x, y: dot.y },
    dotPositions: dotPositions.map((d) => ({ x: d.x, y: d.y })),
    innerPlotArea: {
      x: margins.left,
      y: margins.top,
      width: spec.graphZone.w - margins.left - margins.right,
      height: spec.graphZone.h - margins.top - margins.bottom,
    },
    dotRadius: dotRadiusFor(format),
    labelSize,
    labelWidth: computeLabelWidth(scoreText, labelSize),
  })
  const labelX = spec.graphZone.x + pos.x
  const labelY = spec.graphZone.y + pos.y

  body.push(
    `<text x="${fmt(labelX)}" y="${fmt(labelY)}" fill="${labelColor}" font-family="DM Sans" font-size="${labelSize}" font-weight="500" text-anchor="${pos.anchor}">${scoreText}</text>`,
  )

  // Body copy (plain monochrome in C1).
  body.push(bodyCopy(content.bodyCopy, spec))

  body.push(brandBlock(spec))
  body.push(counterText(slideNumber, spec))

  return { defs, body }
}

// ── Slide 8: takeaway ─────────────────────────────────────────

function composeTakeawaySlide(
  film: FilmData,
  spec: FormatSpec,
  format: '4x5' | '9x16',
): BuiltSvg {
  const defs: string[] = []
  const body: string[] = []

  // Stack items with their heights and margin-bottoms.
  const miniW = spec.miniGraph.w
  const miniH = spec.miniGraph.h
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
        format,
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
    content = composeTakeawaySlide(film, spec, format)
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
