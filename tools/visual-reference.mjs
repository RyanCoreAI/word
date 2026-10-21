import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// node tools/visual-reference.mjs --reference-only --output-dir <directory>
// node tools/visual-reference.mjs --compare --base-url http://127.0.0.1:4173 --output-dir <directory>
// Add --reuse-reference for later app iterations; source/CSS/package hashes must still match.
// --only welcome,group-summary retains earlier captures; --desktop verifies the 390×844 desktop surface.
// --boundary-only --reuse-reference captures real long/untagged dictionary entries at three viewport sizes.
// --boundary-width 320 --boundary-case no-visible-tags limits a regression capture and writes a separate report.
// --motion-check verifies keyed word entry and reduced-motion behavior in the real app.
// All fixtures live in fresh browser contexts. Production files and default queues are never changed.
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(option('--output-dir', process.env.FIDELITY_OUTPUT_DIR ?? 'outputs/word-fidelity'));
const baseUrl = option('--base-url', process.env.QA_BASE_URL ?? 'http://127.0.0.1:4173');
const selectedScreens = args.includes('--only') ? new Set(option('--only', '').split(',').filter(Boolean)) : null;
const boundaryOnly = args.includes('--boundary-only');
const boundaryWidth = Number(option('--boundary-width', 0));
const boundaryCase = option('--boundary-case', '');
assert.ok([0, 320, 430, 1440].includes(boundaryWidth), 'Boundary width must be 320, 430, or 1440');
assert.ok(['', 'long-word', 'no-visible-tags', 'long-definition'].includes(boundaryCase), 'Unknown boundary case');
const reportFilename = boundaryOnly ? `boundary${boundaryWidth ? `-${boundaryWidth}` : ''}${boundaryCase ? `-${boundaryCase}` : ''}-report.json` : 'reference-report.json';
assert.ok(!selectedScreens || args.includes('--reuse-reference'), '--only requires an existing reference report');
const sourceDir = join(root, 'design/mockups-src/src');
const fontFiles = ['inter/400', 'inter/500', 'inter/600', 'inter/700', 'inter/800', 'noto-sans-sc/400', 'noto-sans-sc/500', 'noto-sans-sc/700', 'source-serif-4/600'];
const report = {
  startedAt: new Date().toISOString(), source: 'design/mockups-src/src/board1.html through board5.html + original ui.css',
  normalization: {
    originalBoard: 'Original text/markup/CSS; original build viewport 2000×1200; screenshots at deviceScaleFactor 2.',
    originalScreen: '390×844 CSS px at deviceScaleFactor 1; excludes 12 px outer black phone frame; retains 54 px status, island and home indicator.',
    contentCrop: 'Exact original pixels below y=54; 390×790; no reflow or typography changes.',
    browserNormalized: '390×844 at deviceScaleFactor 1. Remove only native .status/.island/.home-ind; remove .screen corner radius. Original content, CSS sizes, bottom padding, icons and flex layout remain; newly available 54 px naturally participates in flex layout.',
    safeArea: 'Headless browser has no device safe-area inset. Source bottom hint/tabbar padding is preserved in the normalized reference and reported, not silently stretched/scaled.',
    implementation: 'Actual app in a separate fresh context, same 390×844 viewport. Only an explicitly labeled validated fixture is inserted into that isolated IndexedDB. Real ECDICT Word objects are preserved. No fake speech success or production progress is injected.',
  },
  fonts: {}, boards: [], screens: {}, implementation: {}, comparisons: [], desktop: {}, errors: [],
  passedMeaning: 'The source rendering and capture assertions succeeded. Visual acceptance requires reviewing the actual comparisons; passed is not a fidelity score.',
};
const hash = value => createHash('sha256').update(value).digest('hex');
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const relativeUrl = path => `/artifacts/${path.replaceAll('\\', '/')}`;
for (const dir of ['html', 'source', 'implementation', 'comparisons', 'boundaries']) await mkdir(join(output, dir), { recursive: true });

for (const file of fontFiles) {
  const path = join(root, 'node_modules/@fontsource', `${file}.css`);
  await access(path); // Missing fonts must fail rather than silently falling back to system CJK.
  const stylesheet = await readFile(path, 'utf8');
  const assets = [...stylesheet.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)].map(match => resolve(dirname(path), match[1]));
  await Promise.all(assets.map(asset => access(asset)));
  report.fonts[file] = { path, sha256: hash(stylesheet), requiredFontAssets: assets.length, allRequiredFontAssetsPresent: true };
}
await access(join(root, 'node_modules/lucide-static/icons/volume-2.svg'));
report.fontPackages = {};
for (const packageName of ['@fontsource/inter', '@fontsource/noto-sans-sc', '@fontsource/source-serif-4', 'lucide-static']) {
  const pkg = JSON.parse(await readFile(join(root, 'node_modules', packageName, 'package.json'), 'utf8'));
  report.fontPackages[packageName] = pkg.version;
}
report.sourceCssSha256 = hash(await readFile(join(sourceDir, 'ui.css')));

const mime = { '.html': 'text/html;charset=utf-8', '.css': 'text/css;charset=utf-8', '.js': 'text/javascript', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = createHttpServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const mapping = pathname.startsWith('/artifacts/') ? [output, pathname.slice(11)]
      : pathname.startsWith('/node_modules/') ? [join(root, 'node_modules'), pathname.slice(14)]
        : pathname === '/source/ui.css' ? [sourceDir, 'ui.css'] : null;
    if (!mapping) { response.writeHead(404); response.end('Not found'); return; }
    const file = resolve(mapping[0], mapping[1]);
    assert.ok(file.startsWith(`${resolve(mapping[0])}${sep}`), 'Path must stay within its static root');
    const contents = await readFile(file);
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(contents);
  } catch (error) { response.writeHead(404); response.end(error.message); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">${fontFiles.map(file => `<link rel="stylesheet" href="/node_modules/@fontsource/${file}.css">`).join('')}<link rel="stylesheet" href="/source/ui.css">`;
const status = '<div class="island"></div><div class="status"><span>9:41</span><span class="sys"><span class="sig"><i style="height:4px"></i><i style="height:6px"></i><i style="height:8px"></i><i style="height:11px"></i></span><span class="bat"><i></i></span></span></div>';
const normalizedCss = '<style>html,body{width:390px;height:844px;overflow:hidden;background:var(--screen)}.screen{border-radius:0!important}.screen>.status,.screen>.island,.screen>.home-ind{display:none!important}</style>';
const originalCss = '<style>html,body{width:390px;height:844px;overflow:hidden;background:var(--screen)}</style>';
const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL ?? 'chrome', headless: true });
const referenceContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const referencePage = await referenceContext.newPage();
referencePage.on('pageerror', error => report.errors.push({ surface: 'reference', message: error.message }));

async function ready(page) {
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 15px "Noto Sans SC"', '词性和中文已遮住'),
      document.fonts.load('500 15px "Noto Sans SC"', '词性和中文已遮住'),
      document.fonts.load('700 20px "Noto Sans SC"', '看词记忆'),
      document.fonts.load('600 50px "Source Serif 4"', 'elaborate'),
      document.fonts.load('400 18px Inter', 'ɪˈlæbərət'),
    ]);
    await document.fonts.ready;
    // Wait for the finite source entry transition; leave infinite playback indicators alone.
    await Promise.all([...document.querySelectorAll('.word-zone,.listen-zone')].flatMap(node => node.getAnimations())
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
}

async function measurements(page) {
  const values = await page.evaluate(() => {
    const selectors = { screen: '.screen,.app-screen', title: '.t1', word: '.d-word,.word', phonetic: '.d-ph,.phon', card: '.card', chips: '.chips', mask: '.mask', meaning: '.meaning', actions: '.actions', hint: '.hint', chinese: '.m1,.mrow>span:last-child,.blist li', backdrop: '.dialog-backdrop', dialog: '.dialog-sheet' };
    const entries = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const node = document.querySelector(selector); if (!node) continue;
      const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
      entries[name] = { text: node.textContent?.trim().slice(0, 400), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, color: style.color, background: style.backgroundColor, borderRadius: style.borderRadius };
    }
    return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, scrollY, scrollWidth: document.documentElement.scrollWidth, entries,
      fontFaces: [...document.fonts].reduce((result, face) => { const key = `${face.family}/${face.weight}/${face.status}`; result[key] = (result[key] ?? 0) + 1; return result; }, {}) };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root: dom } = await cdp.send('DOM.getDocument');
  values.actualFonts = {};
  for (const [name, selector] of Object.entries({ word: '.word', title: '.t1', chinese: '.m1,.mrow>span:last-child,.blist li', button: '.btn' })) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: dom.nodeId, selector });
    if (nodeId) values.actualFonts[name] = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  }
  await cdp.detach();
  return values;
}

try {
  if (args.includes('--reuse-reference')) {
    const previous = JSON.parse(await readFile(join(output, 'reference-report.json'), 'utf8'));
    assert.equal(previous.sourceCssSha256, report.sourceCssSha256, 'Reference CSS changed; rerender the source');
    assert.deepEqual(previous.fontPackages, report.fontPackages, 'Reference packages changed; rerender the source');
    for (const board of previous.boards) assert.equal(board.sourceSha256, hash(await readFile(join(sourceDir, `board${board.board}.html`), 'utf8')), 'Source board changed; rerender the source');
    assert.equal(previous.boards.length, 5);
    assert.equal(Object.keys(previous.screens).length, 16);
    await Promise.all(Object.keys(previous.screens).map(id => access(join(output, 'source', `${id}-normalized.png`))));
    report.boards = previous.boards;
    report.screens = previous.screens;
    report.referenceReusedFrom = previous.finishedAt;
    if (selectedScreens) {
      report.implementation = Object.fromEntries(Object.entries(previous.implementation).map(([name, capture]) => [name, { capturedAt: previous.finishedAt, ...capture }]));
      report.comparisons = previous.comparisons;
      report.desktop = previous.desktop ?? {};
      report.retainedCapturesFrom = previous.finishedAt;
      report.selectedScreens = [...selectedScreens];
    }
  } else {
  const boardContext = await browser.newContext({ viewport: { width: 2000, height: 1200 }, deviceScaleFactor: 2 });
  const boardPage = await boardContext.newPage();
  for (let board = 1; board <= 5; board += 1) {
    const filename = `board${board}.html`;
    const raw = await readFile(join(sourceDir, filename), 'utf8');
    const icons = [...new Set([...raw.matchAll(/\{\{i:([a-z0-9-]+)\}\}/g)].map(match => match[1]))];
    const iconMap = {};
    for (const name of icons) iconMap[name] = (await readFile(join(root, 'node_modules/lucide-static/icons', `${name}.svg`), 'utf8'))
      .replace(/<!--[\s\S]*?-->/, '').replace(/class="[^"]*"/, 'class="ic"').replace(/\s+/g, ' ').trim();
    const expanded = raw.replace(/\{\{head\}\}/g, head).replace(/\{\{status\}\}/g, status)
      .replace(/\{\{segs:([grcx]+)\}\}/g, (_, sequence) => `<div class="segs">${[...sequence].map(char => `<i class="${({ g: 'g', r: 'r', c: 'cur', x: '' })[char]}"></i>`).join('')}</div>`)
      .replace(/\{\{i:([a-z0-9-]+)\}\}/g, (_, name) => iconMap[name]);
    assert.ok(!expanded.includes('{{'), `Unexpanded template token in ${filename}`);
    await writeFile(join(output, 'html', filename), expanded);
    await boardPage.goto(`${origin}/artifacts/html/${filename}`, { waitUntil: 'networkidle' });
    await ready(boardPage);
    const boardGeometry = await boardPage.locator('.board').boundingBox();
    await boardPage.locator('.board').screenshot({ path: join(output, 'source', `board${board}-original-2x.png`), animations: 'disabled' });
    const shots = await boardPage.locator('.shot').evaluateAll(nodes => nodes.map(node => ({ label: node.querySelector('.label')?.textContent?.trim(), html: node.querySelector('.screen')?.outerHTML })));
    report.boards.push({ board, sourceSha256: hash(raw), boardGeometry, pixelSize: { width: Math.round(boardGeometry.width * 2), height: Math.round(boardGeometry.height * 2) }, shots: shots.length });
    for (const [index, shot] of shots.entries()) {
      assert.ok(shot.html);
      const id = `board${board}-${String(index + 1).padStart(2, '0')}`;
      const originalHtml = `<!doctype html><html lang="zh-CN"><head>${head}${originalCss}</head><body>${shot.html}</body></html>`;
      const normalizedHtml = `<!doctype html><html lang="zh-CN"><head>${head}${normalizedCss}</head><body>${shot.html}</body></html>`;
      await writeFile(join(output, 'html', `${id}-original.html`), originalHtml);
      await writeFile(join(output, 'html', `${id}-normalized.html`), normalizedHtml);
      await referencePage.goto(`${origin}/artifacts/html/${id}-original.html`, { waitUntil: 'networkidle' });
      await ready(referencePage);
      await referencePage.screenshot({ path: join(output, 'source', `${id}-original-screen.png`), animations: 'disabled' });
      await referencePage.screenshot({ path: join(output, 'source', `${id}-content-crop.png`), clip: { x: 0, y: 54, width: 390, height: 790 }, animations: 'disabled' });
      await referencePage.goto(`${origin}/artifacts/html/${id}-normalized.html`, { waitUntil: 'networkidle' });
      await ready(referencePage);
      await referencePage.screenshot({ path: join(output, 'source', `${id}-normalized.png`), animations: 'disabled' });
      report.screens[id] = { label: shot.label, ...await measurements(referencePage) };
    }
    console.log(`Rendered original board ${board}, ${shots.length} source screens in three normalization forms`);
  }
  await boardContext.close();
  }

  const firstFonts = report.screens['board1-01'].actualFonts;
  assert.ok(firstFonts.chinese.some(font => font.familyName.includes('Noto Sans SC') && font.isCustomFont), 'Chinese reference must actually use the packaged Noto Sans SC font');
  assert.ok(firstFonts.word.some(font => font.familyName.includes('Source Serif 4') && font.isCustomFont), 'English word must actually use Source Serif 4');

  if (args.includes('--compare') || boundaryOnly) await captureImplementation();
  report.passed = report.errors.length === 0;
} catch (error) {
  report.passed = false;
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, reportFilename), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  await new Promise(done => server.close(done));
  console.log(`Reference report: ${join(output, reportFilename)}`);
}

async function captureImplementation() {
  const sw = await (await fetch(new URL('sw.js', `${baseUrl}/`))).text();
  report.build = { baseUrl, shell: sw.match(/word-shell-([a-f0-9]+)/)?.[1] ?? null };
  const { createServer } = await import('vite');
  const vite = await createServer({ configFile: false, root, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  let core;
  try { core = await vite.ssrLoadModule('/packages/core/src/index.ts'); } finally { await vite.close(); }
  const manifest = await (await fetch(new URL('data/manifest.json', `${baseUrl}/`))).json();
  const studyResponse = await fetch(new URL(`data/${manifest.study.file}`, `${baseUrl}/`));
  const bytes = Buffer.from(await studyResponse.arrayBuffer());
  assert.equal(hash(bytes), manifest.study.sha256);
  const words = core.parseWords(JSON.parse(bytes.toString('utf8')));
  report.fixture = { label: 'Isolated visual fixture, never real user history', dictionaryVersion: manifest.version, sourceHashVerified: true, wordsUsedUnchanged: ['elaborate', 'scrutiny'], speechSuccessSimulated: false, progressScope: 'fresh temporary Playwright context only' };
  report.normalization.contentDifferences = [
    'Original source text/counters and historical rules remain untouched in source artifacts. The implementation displays real ECDICT phonetic/translation; those may differ from handwritten source copy.',
    'The initial elaborate fixture has no prior answers in the current mode, so the real unknown click produces wrongCount 1 rather than the source illustration count 3. A separate review fixture matches wrongCount 3, streak 1, group 5 and prior group 4.',
    'Source labels the static sample as actively speaking. Actual implementation fixture disables autoSpeak for a stable idle layout; native English audio is never faked.',
    'Native status/home bars, separate British/American source IPA, old cloud/account claims and old dictionary totals are not treated as current app capabilities.',
  ];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    globalThis.__wordAnimationEvents = [];
    document.addEventListener('animationstart', event => {
      if (event.animationName === 'word-enter' && event.target instanceof Element && event.target.matches('.word-zone,.listen-zone')) {
        globalThis.__wordAnimationEvents.push({ animation: event.animationName, target: event.target.className, word: event.target.querySelector('.word')?.textContent ?? null });
      }
    });
  });
  page.on('pageerror', error => report.errors.push({ surface: 'implementation', message: error.message }));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
  await capture('welcome', 'board4-01');
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 60_000 });

  async function fixture(wordId, mode, revealed = false, review = false) {
    const target = words.find(word => word.id === wordId); assert.ok(target);
    const now = Date.UTC(2026, 9, 21, 12);
    const reviewSeeds = [['meticulous', 7, 1], ['ubiquitous', 5, 0], ['plausible', 4, 1], ['ambiguous', 4, 0], ['resilient', 3, 0]];
    const reviewWords = reviewSeeds.map(([id]) => { const word = words.find(item => item.id === id); assert.ok(word); return word; });
    const reviewIds = new Set(reviewWords.map(word => word.id));
    const others = [...words.filter(word => word.id !== wordId && !word.basic && !reviewIds.has(word.id)).slice(0, 14), ...reviewWords];
    const prefix = review ? ['known', 'known'] : ['known', 'known', 'unknown', 'known', 'known', 'unknown', 'known'];
    const groupNumber = review ? 5 : 3;
    const ids = [...others.slice(0, prefix.length).map(word => word.id), target.id, ...others.slice(prefix.length).map(word => word.id)];
    let value = core.createInitialState(manifest.version, now);
    value.settings.autoSpeak = false;
    const progress = Object.fromEntries(reviewSeeds.map(([id, wrongCount, streak]) => [id, {
      status: 'learning', wrongCount, rightCount: streak,
      seenCount: wrongCount + streak, streak, lastAnsweredAt: now - 86_400_000, lastGroup: groupNumber - 1,
    }]));
    if (review) progress[target.id] = { status: 'learning', wrongCount: 3, rightCount: 1, seenCount: 4, streak: 1, lastAnsweredAt: now - 86_400_000, lastGroup: groupNumber - 1 };
    value.modes[mode] = { groupNumber, progress, session: { groupNumber, items: ids, cursor: 0, revealed: false, status: 'active', known: 0, unknown: 0, skipped: 0 } };
    value = core.parseAppState(value, words, manifest.version);
    for (const result of prefix) {
      value = core.answer(value, mode, result, core.getCurrentToken(value, mode), now);
      if (result === 'unknown') value = core.nextWord(value, mode, core.getCurrentToken(value, mode), now);
    }
    if (revealed) value = core.answer(value, mode, 'unknown', core.getCurrentToken(value, mode), now);
    value = core.parseAppState(value, words, manifest.version);
    await page.evaluate(data => new Promise((done, fail) => {
      const opening = indexedDB.open('yanxai-word-v1');
      opening.onerror = () => fail(opening.error?.message);
      opening.onsuccess = () => {
        const db = opening.result; const transaction = db.transaction('state', 'readwrite');
        transaction.objectStore('state').put(data, 'current');
        transaction.oncomplete = () => { db.close(); done(); };
        transaction.onerror = () => { db.close(); fail(transaction.error?.message); };
      };
    }), value);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('navigation', { name: '主导航' }).waitFor();
    return value;
  }
  if (boundaryOnly) {
    const candidates = words.filter(word => !word.basic && /^[a-z]+$/.test(word.word));
    const cases = [
      { name: 'long-word', word: [...candidates].sort((a, b) => b.word.length - a.word.length)[0] },
      { name: 'no-visible-tags', word: candidates.find(word => word.tags.every(tag => !['cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre', 'gk', 'hf'].includes(tag)) && word.word.length >= 8 && word.word.length <= 12) },
      { name: 'long-definition', word: [...candidates].sort((a, b) => b.translation.length - a.translation.length)[0] },
    ].filter(item => !boundaryCase || item.name === boundaryCase);
    report.boundaryCases = cases.map(({ name, word }) => { assert.ok(word); return { name, word }; });
    report.fixture.wordsUsedUnchanged = cases.map(item => item.word.id);
    report.boundaries = [];
    for (const viewport of [{ width: 320, height: 740 }, { width: 430, height: 932 }, { width: 1440, height: 1000 }]) {
      if (boundaryWidth && viewport.width !== boundaryWidth) continue;
      await page.setViewportSize(viewport);
      for (const item of cases) {
        await fixture(item.word.id, 'look');
        await page.getByRole('button', { name: /^看词记忆/ }).click();
        await page.locator('.word').waitFor();
        if (item.name === 'no-visible-tags') assert.equal(await page.locator('.card .chips .chip').count(), 0, 'This real word must have no displayed exam/frequency tags');
        await captureBoundary(`${item.name}-hidden`, viewport, item.word);
        await page.getByRole('button', { name: '不认识', exact: true }).click();
        await page.locator('.meaning').waitFor();
        await captureBoundary(`${item.name}-revealed`, viewport, item.word);
        if (item.name === 'long-definition') {
          await page.getByRole('button', { name: '返回首页', exact: true }).click();
          await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '生词本', exact: true }).click();
          await page.locator('.wl .it').filter({ has: page.locator('.w', { hasText: new RegExp(`^${item.word.word}(?:/|$)`) }) }).click();
          await page.getByRole('dialog', { name: '单词详情' }).waitFor();
          await captureBoundary('long-definition-detail', viewport, item.word);
        }
      }
    }
    await context.close();
    return;
  }
  await fixture('elaborate', 'look');
  await capture('home', 'board3-01');
  if (args.includes('--desktop')) await captureDesktop('home');
  await page.getByRole('button', { name: /^看词记忆/ }).click();
  await page.locator('.word').waitFor();
  assert.equal(await page.locator('.word').innerText(), 'elaborate');
  await capture('look-hidden', 'board1-01');
  if (args.includes('--motion-check')) {
    await ready(page);
    report.motion = { entry: await page.evaluate(() => globalThis.__wordAnimationEvents) };
    assert.equal(report.motion.entry.length, 1, 'Entering a new word must trigger exactly one word-enter animation');
  }
  await page.getByRole('button', { name: '不认识', exact: true }).click();
  await page.locator('.meaning').waitFor();
  await capture('look-revealed', 'board1-02');
  if (args.includes('--motion-check')) {
    await ready(page);
    report.motion.afterReveal = await page.evaluate(() => globalThis.__wordAnimationEvents);
    assert.equal(report.motion.afterReveal.length, 1, 'Revealing the same word must not replay the entry animation');
    await page.getByRole('button', { name: '下一个', exact: true }).click();
    await ready(page);
    report.motion.afterNext = await page.evaluate(() => globalThis.__wordAnimationEvents);
    assert.equal(report.motion.afterNext.length, 2, 'Changing the word ID must trigger one new entry animation');
    assert.notEqual(report.motion.afterNext[1].word, 'elaborate');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await fixture('elaborate', 'look');
    await page.getByRole('button', { name: /^看词记忆/ }).click();
    await ready(page);
    report.motion.reducedMotion = { events: await page.evaluate(() => globalThis.__wordAnimationEvents), animationName: await page.locator('.word-zone').evaluate(node => getComputedStyle(node).animationName) };
    assert.equal(report.motion.reducedMotion.events.length, 0, 'Reduced motion must disable word entry animation');
    assert.equal(report.motion.reducedMotion.animationName, 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  await fixture('elaborate', 'look', false, true);
  await page.getByRole('button', { name: /^看词记忆/ }).click();
  await page.locator('.word').waitFor();
  await capture('look-review', 'board1-03');
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '生词本', exact: true }).click();
  await capture('wordbook', 'board3-03');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
  await capture('settings', 'board3-04');
  await fixture('scrutiny', 'listen');
  await page.getByRole('button', { name: /^听音辨词/ }).click();
  await page.getByRole('button', { name: '播放单词', exact: true }).waitFor();
  await capture('listen-hidden', 'board2-01');
  await fixture('scrutiny', 'listen', true);
  await page.getByRole('button', { name: /^听音辨词/ }).click();
  await page.locator('.meaning').waitFor();
  await capture('listen-revealed', 'board2-02');
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '生词本', exact: true }).click();
  await page.locator('.wl .it').filter({ hasText: 'scrutiny' }).click();
  await page.getByRole('dialog', { name: '单词详情' }).waitFor();
  await capture('word-details', 'board5-01');
  if (args.includes('--desktop')) await captureDesktop('word-details');
  await fixture('elaborate', 'look');
  await page.getByRole('button', { name: /^看词记忆/ }).click();
  await page.getByRole('button', { name: '不认识', exact: true }).click();
  await page.locator('.meaning').waitFor();
  await new Promise(done => setTimeout(done, 350));
  await page.getByRole('button', { name: '下一个', exact: true }).click();
  for (let cursor = 8; cursor < 20; cursor += 1) {
    await new Promise(done => setTimeout(done, 350));
    await page.getByRole('button', { name: '认识', exact: true }).click();
  }
  await page.getByRole('heading', { name: '第 3 组完成', exact: true }).waitFor();
  await capture('group-summary', 'board3-02');
  await context.close();

  async function capture(name, sourceId) {
    if (boundaryOnly) return;
    if (selectedScreens && !selectedScreens.has(name)) return;
    await ready(page);
    await page.evaluate(() => scrollTo(0, 0));
    const path = `implementation/${name}.png`;
    await page.screenshot({ path: join(output, path), animations: 'disabled' });
    report.implementation[name] = { sourceId, screenshot: path, capturedAt: new Date().toISOString(), build: report.build, ...await measurements(page) };
    const comparison = `<!doctype html><html lang="zh-CN"><head>${head}<style>body{padding:24px;background:#ece9e3}.comparison{display:flex;gap:24px;width:804px}figure{width:390px;margin:0}figcaption{height:62px;font:500 14px/1.5 'Noto Sans SC',sans-serif;color:#5b5f68}img{display:block;width:390px;height:844px}.title{font:700 20px 'Noto Sans SC';margin-bottom:18px}</style></head><body><div class="title">${escapeHtml(name)} · 同一 390 × 844 视口</div><div class="comparison"><figure><figcaption>原稿：${sourceId}（仅去原生手机外观）<br>原文、静态视觉状态完整保留</figcaption><img src="${relativeUrl(`source/${sourceId}-normalized.png`)}"></figure><figure><figcaption>真实实现：独立测试上下文<br>真实词典词条；没有模拟发音成功</figcaption><img src="${relativeUrl(path)}"></figure></div></body></html>`;
    await writeFile(join(output, 'html', `${name}-comparison.html`), comparison);
    const comparisonPage = await referenceContext.newPage();
    await comparisonPage.setViewportSize({ width: 852, height: 980 });
    await comparisonPage.goto(`${origin}/artifacts/html/${name}-comparison.html`, { waitUntil: 'networkidle' });
    await ready(comparisonPage);
    const comparisonPath = `comparisons/${name}.png`;
    await comparisonPage.screenshot({ path: join(output, comparisonPath), fullPage: true, animations: 'disabled' });
    report.comparisons = report.comparisons.filter(item => item.name !== name);
    report.comparisons.push({ name, source: `source/${sourceId}-normalized.png`, implementation: path, image: comparisonPath });
    await comparisonPage.close();
    console.log(`Compared ${name}`);
  }

  async function captureBoundary(name, viewport, word) {
    await ready(page);
    await page.evaluate(() => scrollTo(0, 0));
    const layout = await page.evaluate(() => {
      const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom, right: box.right }; };
      const actions = [...document.querySelectorAll('.actions .btn')].map(node => ({ label: node.textContent.trim(), ...rect(node) }));
      const horizontalOverflows = [...document.querySelectorAll('.app-screen,.card,.meaning,.dialog,.phon,.d-ph,.d-word')].filter(node => node.scrollWidth > node.clientWidth + 1).map(node => ({ className: node.className, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
      return { documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight, actions, horizontalOverflows,
        scrollableContent: [...document.querySelectorAll('.card,.meaning,.dialog')].map(node => ({ className: node.className, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: getComputedStyle(node).overflowY })),
        surface: rect(document.querySelector('.app-screen')), word: document.querySelector('.word') ? rect(document.querySelector('.word')) : null };
    });
    const issues = [];
    if (layout.documentWidth > viewport.width) issues.push('Document overflows horizontally');
    if (layout.horizontalOverflows.length) issues.push('Content container overflows horizontally');
    if (layout.actions.some(button => button.x < 0 || button.right > viewport.width + 1 || button.y < 0 || button.bottom > viewport.height + 1)) issues.push('Primary answer action is outside the viewport');
    const path = `boundaries/${viewport.width}x${viewport.height}-${name}.png`;
    await page.screenshot({ path: join(output, path), animations: 'disabled' });
    report.boundaries.push({ name, wordId: word.id, viewport, screenshot: path, layout, issues });
    for (const issue of issues) report.errors.push({ surface: `${viewport.width}x${viewport.height}-${name}`, message: issue });
    console.log(`Boundary ${viewport.width}×${viewport.height} ${name} (${word.word}): ${issues.length ? issues.join('; ') : 'no overflow; actions visible'}`);
  }

  async function captureDesktop(name) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await ready(page);
    await page.evaluate(() => scrollTo(0, 0));
    const dimensions = await measurements(page);
    const surface = dimensions.entries.screen;
    assert.equal(surface.width, 390, 'Desktop app must retain the 390 px source width');
    assert.equal(surface.height, 844, 'Desktop app must retain the 844 px source height');
    assert.equal(surface.x, 525, 'Desktop app must be horizontally centered');
    assert.equal(surface.y, 24, 'Desktop app must keep its intended outer margin');
    assert.ok(dimensions.scrollWidth <= 1440, 'Desktop must not overflow horizontally');
    if (name === 'word-details') {
      const { backdrop, dialog } = dimensions.entries;
      assert.equal(backdrop.x, surface.x);
      assert.equal(backdrop.y, surface.y);
      assert.equal(backdrop.width, surface.width);
      assert.equal(backdrop.height, surface.height);
      assert.equal(dialog.y - surface.y, 96, 'Detail sheet must start 96 px inside the app surface');
      assert.equal(dialog.x, surface.x);
      assert.equal(dialog.width, surface.width);
      assert.equal(dialog.y + dialog.height, surface.y + surface.height);
    }
    const path = `implementation/desktop-${name}.png`;
    await page.screenshot({ path: join(output, path), animations: 'disabled' });
    report.desktop[name] = { screenshot: path, capturedAt: new Date().toISOString(), build: report.build, ...dimensions };
    console.log(`Captured desktop ${name}: app ${surface.width}×${surface.height} at ${surface.x},${surface.y}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await ready(page);
  }
}
