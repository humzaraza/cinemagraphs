import sharp from 'sharp'

const WIDTH = 1200
const HEIGHT = 630
const BG = '#0D0D1A'
const GOLD = '#C8A951'
const TEAL = '#2DD4A8'
const MUTED = 'rgba(255,255,255,0.4)'
const ACCENT_BAR_H = 6

// Build a smooth sine-like path for decorative graph lines
function buildGraphPath(startX, startY, width, amplitude, frequency, phase) {
  const points = []
  for (let x = startX; x <= startX + width; x += 2) {
    const y = startY + amplitude * Math.sin((x - startX) * frequency * Math.PI / width + phase)
    points.push(`${x},${y}`)
  }
  return `M${points[0]} ` + points.slice(1).map(p => `L${p}`).join(' ')
}

// Multiple decorative graph lines
const graphLines = [
  // Gold lines — main sentiment curves
  { color: GOLD, opacity: 0.12, startX: 80, startY: 320, width: 1040, amplitude: 80, frequency: 3, phase: 0, strokeWidth: 2.5 },
  { color: GOLD, opacity: 0.08, startX: 80, startY: 340, width: 1040, amplitude: 60, frequency: 2.5, phase: 1.2, strokeWidth: 2 },
  { color: GOLD, opacity: 0.06, startX: 80, startY: 300, width: 1040, amplitude: 50, frequency: 4, phase: 2.5, strokeWidth: 1.5 },
  // Teal lines — user sentiment curves
  { color: TEAL, opacity: 0.10, startX: 80, startY: 330, width: 1040, amplitude: 70, frequency: 3.5, phase: 0.8, strokeWidth: 2 },
  { color: TEAL, opacity: 0.06, startX: 80, startY: 310, width: 1040, amplitude: 45, frequency: 2, phase: 3.0, strokeWidth: 1.5 },
]

const graphSvgPaths = graphLines.map(l => {
  const d = buildGraphPath(l.startX, l.startY, l.width, l.amplitude, l.frequency, l.phase)
  return `<path d="${d}" fill="none" stroke="${l.color}" stroke-opacity="${l.opacity}" stroke-width="${l.strokeWidth}" stroke-linecap="round"/>`
}).join('\n    ')

// Vertical grid lines (subtle)
const gridLines = []
for (let x = 180; x < 1100; x += 120) {
  gridLines.push(`<line x1="${x}" y1="180" x2="${x}" y2="520" stroke="white" stroke-opacity="0.03" stroke-width="1"/>`)
}
// Horizontal grid lines
for (let y = 220; y < 500; y += 60) {
  gridLines.push(`<line x1="80" y1="${y}" x2="1120" y2="${y}" stroke="white" stroke-opacity="0.03" stroke-width="1"/>`)
}

const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>

  <!-- Subtle radial glow behind text -->
  <defs>
    <radialGradient id="glow" cx="50%" cy="40%" r="50%">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>

  <!-- Grid lines -->
  ${gridLines.join('\n  ')}

  <!-- Decorative graph lines -->
  <g>
    ${graphSvgPaths}
  </g>

  <!-- Main title: Cinemagraphs -->
  <text x="600" y="270" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="82" font-weight="700" fill="${GOLD}"
        letter-spacing="2">
    Cinemagraphs
  </text>

  <!-- Tagline -->
  <text x="600" y="330" text-anchor="middle"
        font-family="'Helvetica Neue', Arial, sans-serif"
        font-size="26" fill="${MUTED}"
        letter-spacing="1">
    Movie reviews, visualized.
  </text>

  <!-- Small domain -->
  <text x="600" y="380" text-anchor="middle"
        font-family="'Helvetica Neue', Arial, sans-serif"
        font-size="18" fill="rgba(255,255,255,0.25)"
        letter-spacing="3">
    cinemagraphs.ca
  </text>

  <!-- Gold accent bar at bottom -->
  <rect x="0" y="${HEIGHT - ACCENT_BAR_H}" width="${WIDTH}" height="${ACCENT_BAR_H}" fill="${GOLD}"/>

  <!-- Thin teal accent line above gold bar -->
  <rect x="0" y="${HEIGHT - ACCENT_BAR_H - 2}" width="${WIDTH}" height="2" fill="${TEAL}" opacity="0.4"/>
</svg>`

await sharp(Buffer.from(svg)).png().toFile('public/og-image.png')
console.log('Generated public/og-image.png (1200x630)')
