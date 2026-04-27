#!/usr/bin/env node
// Local test for the overlay render pipeline.
// Usage: node scripts/test-overlay-render.mjs [horizontal|vertical]
// Output: test-<format>.webm in repo root.

import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const format = process.argv[2] || 'horizontal';

if (!['horizontal', 'vertical'].includes(format)) {
  console.error(`Invalid format "${format}". Use "horizontal" or "vertical".`);
  process.exit(1);
}

const HTML_PATH = resolve(__dirname, '..', 'src', 'overlays', `${format}.html`);
const OUT_PATH = resolve(__dirname, '..', `test-${format}.webm`);
const VIEWPORT = format === 'vertical'
  ? { width: 1080, height: 1920 }
  : { width: 1920, height: 1080 };

console.log(`Format:   ${format}`);
console.log(`Loading:  ${HTML_PATH}`);
console.log(`Viewport: ${VIEWPORT.width}x${VIEWPORT.height}`);
console.log(`Output:   ${OUT_PATH}`);

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required'
  ]
});

const page = await browser.newPage();
await page.setViewport(VIEWPORT);

const startedAt = Date.now();
await page.goto(`file://${HTML_PATH}?render=1`, { waitUntil: 'networkidle0' });

console.log('Recording... animation is ~21s, allow up to 35s.');
await page.waitForFunction(() => window.__renderComplete === true, { timeout: 35000 });

const dataUrl = await page.evaluate(() => window.__renderResult);
if (!dataUrl || !dataUrl.startsWith('data:video/webm')) {
  console.error('Unexpected __renderResult shape:', dataUrl?.slice(0, 80));
  await browser.close();
  process.exit(2);
}

const base64 = dataUrl.split(',')[1];
const buffer = Buffer.from(base64, 'base64');
writeFileSync(OUT_PATH, buffer);

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Wrote ${buffer.length.toLocaleString()} bytes to ${OUT_PATH} in ${elapsedSec}s`);
await browser.close();
