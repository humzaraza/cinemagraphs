# Cinemagraphs Graph Overlay Specification v4

## CRITICAL: Read this entire document before writing any code. Follow every rule exactly. Do not improvise or make design decisions not specified here.

---

## Changes from v3

This version updates the spec to match the actual working HTML overlay files. The previous spec described several behaviors that the production files diverged from. The production files are the source of truth. The spec now matches them.

What changed:

1. Line draw progress is LINEAR, not easeInOutCubic. Uniform speed across the full 16 seconds. The eased version felt laggy at the start and end.
2. Dot fade-in is time-based at 250ms, not 15-frame-based. Smoother on screen recordings and more deterministic for server-side rendering.
3. The first data point at t:0 is hidden. The curve still anchors at score 5.0, but no visible dot is drawn there. The dot loop starts at index 1.
4. Score font sizes are smaller than v3 specified. Horizontal: Math.max(32, W * 0.035). Vertical: Math.max(32, W * 0.07).
5. Vertical score positioning is more precise. The "Overall" label sits ABOVE the topY line (textBaseline 'bottom', at topY - 6). The score number sits BELOW the topY line (textBaseline 'top', at topY + 6).
6. X-axis time labels are auto-generated with a defined algorithm that handles end-of-runtime collision automatically. No more hand-tuning per film.
7. Y-axis and X-axis label sizes for vertical are now specified explicitly as Math.max(11, W * 0.022).

Everything else (colors, fonts, fade-in math, area fill, glow line, monotone cubic interpolation, watermark) stays as in v3.

---

## Overview

This document defines how to build animated sentiment graph overlays for Cinemagraphs marketing videos. There are two formats: HORIZONTAL (16:9) and VERTICAL (9:16). Both share the same core graph rules but differ in layout.

---

## PART 1: SHARED RULES (apply to BOTH formats)

### Background
- Body and canvas background: exactly #000000 (pure black)
- This is required for CapCut's "Screen" blend mode to make the background transparent
- Never use rgba, never use #0D0D1A, never use any color other than #000000

### Canvas Setup
- Use HTML5 canvas element
- Scale factor: 2 (for retina sharpness)
- Size canvas to its container on every frame
- ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)

### Data Format
- First data point is ALWAYS { t: 0, s: 5.0, c: 'red' }
- Data extracted from screenshot: each dot = one data point with timestamp (minutes), score, and color
- Color rules: c: 'red' for scores below 6, c: 'gold' for 6 to 7.9, c: 'teal' for 8 and above
- Store as: var data = [ { t: 0, s: 5.0, c: 'red' }, { t: 4, s: 8.5, c: 'teal' }, ... ];
- Also store: var OVERALL_SCORE = '8.2'; var TOTAL_TIME = 157;

### Color Map
```
var colorMap = {
  red: '#E05555',
  gold: '#C8A951',
  teal: '#2DD4A8',
};
```

### Y-Axis Range (CRITICAL - applies to both formats)
- Calculate from the data:
  - Y_MIN = Math.max(1, Math.floor(lowestScoreInData) - 1)
  - Y_MAX = Math.min(10, Math.ceil(highestScoreInData) + 1)
  - Y_RANGE = Y_MAX - Y_MIN
- Example: if lowest score is 5.9 and highest is 9.5, then Y_MIN = 4, Y_MAX = 10, Y_RANGE = 6
- This ensures the graph fills vertical space and the arc looks dramatic

### Curve Rendering (Monotone Cubic Hermite Interpolation)

Subdivide each segment into 30 points using the Fritsch-Carlson monotone cubic algorithm. This creates a smooth curve that passes through every data point exactly and does not overshoot at peaks. Calculate cumulative arc lengths for uniform-speed animation.

The algorithm has four steps. Compute steps 1 through 3 ONCE (before any subdivision). Compute step 4 for each segment.

```javascript
// Assume `pts` is the array of screen-space data points { x, y }
// after tX and sY have been applied.

// Step 1: compute slopes between consecutive data points
var slopes = [];
for (var i = 0; i < pts.length - 1; i++) {
  slopes[i] = (pts[i+1].y - pts[i].y) / (pts[i+1].x - pts[i].x);
}

// Step 2: compute tangent at each data point (weighted harmonic mean)
var tangents = new Array(pts.length);
tangents[0] = slopes[0];
for (var i = 1; i < pts.length - 1; i++) {
  if (slopes[i-1] * slopes[i] <= 0) {
    tangents[i] = 0;
  } else {
    var dx0 = pts[i].x - pts[i-1].x;
    var dx1 = pts[i+1].x - pts[i].x;
    var w0 = 2 * dx1 + dx0;
    var w1 = dx1 + 2 * dx0;
    tangents[i] = (w0 + w1) / (w0 / slopes[i-1] + w1 / slopes[i]);
  }
}
tangents[pts.length - 1] = slopes[slopes.length - 1];

// Step 3: apply monotonicity constraint (prevents overshoot)
for (var i = 0; i < slopes.length; i++) {
  if (slopes[i] === 0) {
    tangents[i] = 0;
    tangents[i+1] = 0;
  } else {
    var a = tangents[i] / slopes[i];
    var b = tangents[i+1] / slopes[i];
    var h = a * a + b * b;
    if (h > 9) {
      var tau = 3 / Math.sqrt(h);
      tangents[i] = tau * a * slopes[i];
      tangents[i+1] = tau * b * slopes[i];
    }
  }
}

// Step 4: subdivide each segment into 30 points using cubic Hermite
for (var step = 0; step < 30; step++) {
  var t = step / 30;
  var tt = t * t;
  var ttt = tt * t;
  var h00 = 2*ttt - 3*tt + 1;
  var h10 = ttt - 2*tt + t;
  var h01 = -2*ttt + 3*tt;
  var h11 = ttt - tt;
  var dx = pts[i+1].x - pts[i].x;
  var x = pts[i].x + dx * t;
  var y = h00 * pts[i].y + h10 * dx * tangents[i] + h01 * pts[i+1].y + h11 * dx * tangents[i+1];
}
```

Do NOT use Catmull-Rom. The monotone cubic algorithm above guarantees the curve passes through every data point.

After building the curve, compute cumulative arc lengths so the line can be animated at uniform speed:
```javascript
var arcLengths = [0];
var totalLength = 0;
for (var i = 1; i < curve.length; i++) {
  var ddx = curve[i].x - curve[i-1].x;
  var ddy = curve[i].y - curve[i-1].y;
  totalLength += Math.sqrt(ddx*ddx + ddy*ddy);
  arcLengths.push(totalLength);
}
```

### Animated Head (interpolated within segment)
The head of the line must be interpolated within the current segment, not snapped to segment boundaries. Snapping causes a visible 1-2 frame stutter when the head jumps between segments. Find the segment containing the target arc length, then interpolate the exact head position within that segment using a sub-segment fraction. The leading dot is drawn at this interpolated position.

### Area Fill (under the curve)
- Gradient from graph top to graph bottom:
  - Stop 0: rgba(200, 169, 81, 0.18)
  - Stop 0.6: rgba(200, 169, 81, 0.04)
  - Stop 1.0: rgba(200, 169, 81, 0)
- Path: from curve start, along the visible portion of the curve up to the interpolated head, then down to the bottom of the graph area, then left to the start, close.

### Glow Line (drawn BEFORE main line)
- Same path as main line (visible portion only, ending at interpolated head)
- Color: rgba(200, 169, 81, 0.2)
- Width: 10px
- lineCap: round, lineJoin: round

### Main Line
- Color: #C8A951
- Width: 4.5px (horizontal) or 5px (vertical)
- lineCap: round, lineJoin: round
- Constant width, do not vary.

### Leading Dot (animated head of the line)
- Outer glow: circle, rgba(200, 169, 81, 0.3), radius 7px
- Inner dot: circle, #C8A951, radius 3.5px
- Drawn ONLY while the line is still drawing (lineProgress < 1)
- Drawn at the interpolated head position

### Data Point Dots
- Appear AFTER the line passes through them. Detection: when targetLength >= the arc length at that dot's position on the curve.
- The first data point (index 0, t:0, s:5.0) is HIDDEN. The dot loop starts at index 1.
- Fade in over 250ms of real elapsed time:
  - On first visible frame, record dotFirstVisible[di] = elapsed
  - dotAlpha = Math.min(1, (elapsed - dotFirstVisible[di]) / 250)
- Each visible dot draws TWO circles:
  1. Outer glow: colorMap[d.c] at (dotAlpha * 0.3) opacity, radius = r + 5
  2. Inner dot: colorMap[d.c] at dotAlpha opacity, radius = r
- Dot outline on inner dot: rgba(0, 0, 0, 0.6), 1.5px stroke
- All dots same size.

### Easing Functions
```javascript
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}
```
easeInOutCubic is defined for completeness but NOT used for line drawing. Line drawing uses linear progress. smoothstep IS used for the fade-in alpha.

### Animation Timing
- DURATION = 16000 (16 seconds to draw the line)
- FADE_IN_DURATION = 1200 (1.2 seconds for axes/score/watermark fade-in)
- HOLD = 4000 (4 seconds to hold the final frame)
- Line drawing uses LINEAR progress: var lineProgress = Math.min(1, elapsed / DURATION);
- Fade-in uses smoothstep for alpha
- Total animation: ~21.2 seconds

### What Fades In Together (CRITICAL)
After the line finishes drawing, ALL of the following fade in using the SAME alpha value from ONE smoothstep calculation:
- Y-axis lines (both sides)
- X-axis line (bottom)
- Horizontal grid lines
- Dashed neutral/midpoint line
- Y-axis number labels (both sides)
- X-axis time labels
- Score ("Overall" label + score number)
- Watermark (vertical only; horizontal watermark always visible)

Do NOT use separate timers, separate alpha values, or shadows that make any element appear brighter or faster.

### Axes and Grid Drawing Rules
- Y-axis lines: rgba(232, 228, 220, 0.45), lineWidth 1.5, BOTH sides
- X-axis line: rgba(232, 228, 220, 0.45), lineWidth 1.5, bottom
- Horizontal grid lines: rgba(232, 228, 220, 0.1), lineWidth 0.5, one per whole number
- Dashed line at score 5 if within Y range: rgba(232, 228, 220, 0.25), lineWidth 1.5, setLineDash([6, 5])
- Y-axis labels: rgba(232, 228, 220, 0.55), DM Sans 400
  - Left side: textAlign 'right', positioned at leftX - 8
  - Right side: textAlign 'left', positioned at rightX + 8
  - Show every whole number from Y_MIN to Y_MAX
- X-axis time labels: rgba(232, 228, 220, 0.5), DM Sans 400

### X-Axis Time Label Generation Algorithm

Time labels MUST be auto-generated, not hand-tuned per film.

Formatting function:
```javascript
function formatTimeLabel(minutes) {
  if (minutes < 60) return minutes + 'm';
  var hours = Math.floor(minutes / 60);
  var mins = minutes % 60;
  if (mins === 0) return hours + 'h';
  return hours + 'h ' + mins + 'm';
}
```

Horizontal label generation (every 20 minutes plus the final tick):
```javascript
function generateHorizontalTimeLabels(totalTime) {
  var labels = [];
  for (var t = 0; t < totalTime; t += 20) {
    labels.push({ t: t, l: formatTimeLabel(t) });
  }
  if (labels.length > 1 && totalTime - labels[labels.length - 1].t < 15) {
    labels.pop();
  }
  labels.push({ t: totalTime, l: formatTimeLabel(totalTime) });
  return labels;
}
```

Worked examples:
- totalTime = 124 → 0m, 20m, 40m, 1h, 1h 20m, 1h 40m, 2h 4m
- totalTime = 119 → 0m, 20m, 40m, 1h, 1h 20m, 1h 40m, 1h 59m
- totalTime = 157 → 0m, 20m, 40m, 1h, 1h 20m, 1h 40m, 2h, 2h 20m, 2h 37m
- totalTime = 60 → 0m, 1h

Vertical label generation (5 labels max, evenly distributed):
```javascript
function generateVerticalTimeLabels(totalTime) {
  return [
    { t: 0,                              l: formatTimeLabel(0)                              },
    { t: Math.round(totalTime * 0.25),   l: formatTimeLabel(Math.round(totalTime * 0.25))   },
    { t: Math.round(totalTime * 0.5),    l: formatTimeLabel(Math.round(totalTime * 0.5))    },
    { t: Math.round(totalTime * 0.75),   l: formatTimeLabel(Math.round(totalTime * 0.75))   },
    { t: totalTime,                      l: formatTimeLabel(totalTime)                      }
  ];
}
```

### Score Display
- "Overall" label: rgba(232, 228, 220, 0.4), DM Sans 400 weight, small size
- Score number: #C8A951, DM Sans 500 weight (NOT 700, not bold)
- NO shadow, NO glow, NO text-shadow on the score
- Positioning rules differ between horizontal and vertical (see format-specific sections)

### Watermark Text
- Line 1: "Cinemagraphs" — Libre Baskerville 700 weight, #C8A951
- Line 2: "Movie reviews, visualized" — DM Sans 300 weight, #E8E4DC
- Always rendered at 25% opacity (multiplied with fade alpha for vertical, constant for horizontal)

### Fonts
```html
<link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
```

### Restart Button
- Position: absolute, top 12px, right 12px
- Background: rgba(200, 169, 81, 0.2), border: 1px solid rgba(200, 169, 81, 0.4)
- Color: #C8A951, font-size 12px, padding 8px 18px, border-radius 6px
- Use addEventListener('click', ...) — NOT inline onclick
- On click: cancel animation frame, reset state, clear canvas, restart after 200ms delay

### Things That Must NEVER Appear
- No em dashes anywhere
- No story beat labels or pill tags
- No film title in the overlay
- No "Anchored from" text
- No shadow or glow on the score number
- No varying dot sizes
- No varying line thickness
- No visible dot at t:0

---

## PART 2: HORIZONTAL FORMAT (16:9)

Use this for: Twitter/X, YouTube, horizontal video overlays

### Layout
```css
body {
  background: #000000;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
```
Canvas fills the full viewport.

### Graph Bounds
```javascript
var GRAPH_HEIGHT = 0.65;
var MARGIN_X = 0.08;

function getTopY() { return H * ((1 - GRAPH_HEIGHT) / 2); }
function getBotY() { return H - H * ((1 - GRAPH_HEIGHT) / 2); }
function tX(t) { return W * MARGIN_X + (t / TOTAL_TIME) * W * (1 - 2 * MARGIN_X); }
function sY(s) {
  var top = getTopY();
  var bot = getBotY();
  var graphH = bot - top;
  return top + graphH - ((s - Y_MIN) / Y_RANGE) * graphH;
}
```
CRITICAL: The last data point's timestamp MUST equal TOTAL_TIME.

### Dot Radius
```javascript
var r = Math.max(5, W * 0.005);
```

### Y-Axis Label Size
```javascript
var yLabelSize = Math.max(11, W * 0.011);
```

### X-Axis Time Label Size
```javascript
var xLabelSize = Math.max(11, W * 0.011);
```

### Score Position
- Top RIGHT corner, inside the graph bounds
- Offset from right y-axis by Math.max(30, W * 0.03)
- Score font size: Math.max(32, W * 0.035)
- "Overall" label font size: Math.max(11, W * 0.011)
- "Overall" centered horizontally above the score number
- "Overall" baseline: top, drawn at topY + 6
- Score number baseline: top, drawn at topY + 6 + labelFontSize + 4

### Watermark Position
- Top LEFT corner, inside the graph bounds
- Positioned at leftX + Math.max(15, W * 0.015), topY + Math.max(5, H * 0.005)
- ALWAYS VISIBLE (does not fade in — drawn every frame at 25% opacity)
- "Cinemagraphs" font size: Math.max(13, W * 0.013)
- Subtitle font size: Math.max(9, W * 0.008)
- Subtitle drawn at wmY + cinemagraphsFontSize + 2

### X-Axis Time Labels
Use generateHorizontalTimeLabels(TOTAL_TIME).

---

## PART 3: VERTICAL FORMAT (9:16)

Use this for: TikTok, Instagram Reels.

### Layout
```css
body {
  background: #000000;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  display: flex;
  justify-content: center;
  align-items: center;
}

.frame {
  aspect-ratio: 9 / 16;
  height: 100vh;
  max-width: 100vw;
  position: relative;
  overflow: hidden;
  background: #000000;
}
```

### Graph Bounds
```javascript
var GRAPH_TOP_PCT = 0.15;
var GRAPH_BOT_PCT = 0.75;
var MARGIN_X = 0.08;

function getTopY() { return H * GRAPH_TOP_PCT; }
function getBotY() { return H * GRAPH_BOT_PCT; }
```

### What is NOT in the vertical format
- NO title text
- NO film name
- NO year/runtime text

### Dot Radius
```javascript
var r = Math.max(5, W * 0.014);
```

### Y-Axis Label Size
```javascript
var yLabelSize = Math.max(11, W * 0.022);
```

### X-Axis Time Label Size
```javascript
var xLabelSize = Math.max(11, W * 0.022);
```

### Score Position
- Top LEFT corner, inside the graph bounds
- "Overall" label: textAlign 'left', textBaseline 'bottom', drawn at (leftX + 10, topY - 6)
- Score number: textAlign 'left', textBaseline 'top', drawn at (leftX + 10, topY + 6)
- Score font size: Math.max(32, W * 0.07)
- Label font size: Math.max(9, W * 0.022)

### Watermark Position
- Below dashed neutral line at score 5 (only if 5 is within Y range)
- Positioned at leftX + 10, ny + 10 (where ny = sY(5))
- FADES IN with the axes
- Uses ctx.globalAlpha = fadeAlpha * 0.25
- "Cinemagraphs" font size: Math.max(12, W * 0.032)
- Subtitle font size: Math.max(8, W * 0.02)
- Subtitle drawn at ny + 10 + cinemagraphsFontSize + 2

### X-Axis Time Labels
Use generateVerticalTimeLabels(TOTAL_TIME). Always 5 labels.

---

## PART 4: AUTOMATED RENDERER (in development)

A server-side renderer is being built into the cinemagraphs.ca admin section at /admin/video/list. It uses headless Chrome (Puppeteer with @sparticuz/chromium on Vercel) to load this overlay HTML with real Postgres film data injected, captures the animation, and returns an MP4 directly to the browser as a download.

The overlay HTML files support:
1. Data injection via window.__OVERLAY_DATA__ (preferred) or ?data= URL query param
2. A deterministic render mode (window.__RENDER_MODE__ === 'deterministic') where the animation is driven by external calls to window.renderFrameAt(elapsedMs)

In default mode (no render mode flag), the overlays continue to work exactly as today: auto-start, RESTART button visible, real-time animation.
