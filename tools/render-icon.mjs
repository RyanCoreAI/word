import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Rasterize the existing Claude mockup mark without redesigning it.
// Source: design/mockups-src/src/ui.css, .app-mark and .app-mark::after;
// Markup is extracted from board4.html; the original glyph is retained exactly.
const root = fileURLToPath(new URL('../', import.meta.url));
const stylesheet = await readFile(path.join(root, 'design/mockups-src/src/ui.css'), 'utf8');
const board = await readFile(path.join(root, 'design/mockups-src/src/board4.html'), 'utf8');
const markup = board.match(/<div class="app-mark">[^<]+<\/div>/)?.[0];
if (!markup) throw new Error('The original Claude app-mark markup is missing.');
const rules = [
  stylesheet.match(/:root\s*\{[^}]*\}/)?.[0],
  stylesheet.match(/\.app-mark\s*\{[^}]*\}/)?.[0],
  stylesheet.match(/\.app-mark::after\s*\{[^}]*\}/)?.[0],
];
if (rules.some(rule => !rule)) throw new Error('The original Claude app-mark rules are missing.');
const font = await readFile(path.join(root, 'node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-700-normal.woff2'));
const output = path.join(root, 'apps/web/public/icons');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face { font-family: 'Noto Sans SC'; font-style: normal; font-weight: 700; font-display: block; src: url(data:font/woff2;base64,${font.toString('base64')}) format('woff2'); }
      ${rules.join('\n')}
      html, body { margin: 0; width: ${size}px; height: ${size}px; overflow: hidden; background: transparent; }
      body { font-family: var(--sans); -webkit-font-smoothing: antialiased; }
      .app-mark { transform: scale(${size / 84}); transform-origin: top left; }
    </style></head><body>${markup}</body></html>`);
    await page.evaluate(async () => { await document.fonts.load('700 44px "Noto Sans SC"', '词'); await document.fonts.ready; });
    const filename = path.join(output, `icon-${size}.png`);
    await page.screenshot({ path: filename, omitBackground: true, animations: 'disabled' });
    await page.close();
    process.stdout.write(`Rendered ${path.relative(root, filename)} (${size} x ${size})\n`);
  }
} finally {
  await browser.close();
}
