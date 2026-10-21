// Inline lucide icons into templates, then screenshot each .board at 2x.
const fs = require('fs');
const path = require('path');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node-tools/node_modules/playwright'));
}

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'dist');
const PNG = process.argv[2] || path.join(__dirname, 'png');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PNG, { recursive: true });

const icon = (name) => {
  const raw = fs.readFileSync(path.join(__dirname, 'node_modules/lucide-static/icons', name + '.svg'), 'utf8');
  return raw.replace(/<!--[\s\S]*?-->/, '').replace(/class="[^"]*"/, 'class="ic"').replace(/\s+/g, ' ').trim();
};

const HEAD = [
  '<meta charset="utf-8">',
  ...['inter/400', 'inter/500', 'inter/600', 'inter/700', 'inter/800', 'noto-sans-sc/400', 'noto-sans-sc/500', 'noto-sans-sc/700', 'source-serif-4/600']
    .map((f) => '<link rel="stylesheet" href="../node_modules/@fontsource/' + f + '.css">'),
  '<link rel="stylesheet" href="../src/ui.css">',
].join('\n');
const STATUS = '<div class="island"></div><div class="status"><span>9:41</span><span class="sys"><span class="sig"><i style="height:4px"></i><i style="height:6px"></i><i style="height:8px"></i><i style="height:11px"></i></span><span class="bat"><i></i></span></span></div>';

const pages = fs.readdirSync(SRC).filter((f) => f.startsWith('board') && f.endsWith('.html'));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 2000, height: 1200 }, deviceScaleFactor: 2 });
  for (const f of pages) {
    const html = fs.readFileSync(path.join(SRC, f), 'utf8')
      .replace(/\{\{head\}\}/g, HEAD)
      .replace(/\{\{status\}\}/g, STATUS)
      .replace(/\{\{segs:([grcx]+)\}\}/g, (_, s) => '<div class="segs">' + [...s].map((c) => '<i class="' + ({ g: 'g', r: 'r', c: 'cur', x: '' })[c] + '"></i>').join('') + '</div>')
      .replace(/\{\{i:([a-z0-9-]+)\}\}/g, (_, n) => icon(n));
    const out = path.join(OUT, f);
    fs.writeFileSync(out, html);
    await page.goto('file://' + out);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const el = await page.$('.board');
    const png = path.join(PNG, f.replace('.html', '.png'));
    await el.screenshot({ path: png });
    console.log('wrote', png);
  }
  await browser.close();
})();
