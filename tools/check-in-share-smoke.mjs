import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import jsQR from 'jsqr';
import pngjs from 'pngjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/';
const origin = new URL(url).origin;
const output = path.resolve(process.env.WORD_SHARE_OUTPUT ?? path.join(root, '../../outputs/word-study-plan/share-browser'));
const HOME = 'https://word.yanxai.com/';
await mkdir(output, { recursive: true });
const report = {
  startedAt: new Date().toISOString(), url,
  device: 'Isolated Chrome profile; 390x844/320x568 mobile viewports and 1440x1000 desktop, not physical Android',
  fixture: 'Only this isolated browser database is seeded. Counts are produced by real core answer/plan functions, not real user study.',
  nativeShareBoundary: 'No message is sent to another app/contact. Native target selection/delivery and phone-gallery saving are not established by headless Chrome.',
  checks: [], pageErrors: [], imageRequests: [], thirdPartyRequests: [], asrRequests: [], audioRequests: [],
};
const browser = await chromium.launch({ channel: 'chrome', headless: true });
report.browserVersion = browser.version();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Tijuana', acceptDownloads: true, serviceWorkers: 'allow' });
const page = await context.newPage(); page.setDefaultTimeout(30_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
context.on('request', request => {
  const resource = new URL(request.url());
  if (!resource.protocol.startsWith('http')) return;
  if (resource.origin !== origin) report.thirdPartyRequests.push(request.url());
  if (/\/images\/check-in\/\d{2}\.png$/.test(resource.pathname)) report.imageRequests.push(request.url());
  if (resource.pathname.startsWith('/asr/')) report.asrRequests.push(request.url());
  if (resource.pathname.startsWith('/audio/')) report.audioRequests.push(request.url());
});
const check = async (name, run) => {
  const detail = await run(); report.checks.push({ name, status: 'passed', detail });
  console.log(JSON.stringify({ name, status: 'passed', detail }));
};
const share = () => page.locator('.check-in-share');
const shareButton = () => page.getByRole('button', { name: '分享打卡图', exact: true });
async function readDatabase(store, key) {
  return page.evaluate(({ store, key }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('yanxai-word-v1'); request.onerror = () => reject(request.error?.message);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction(store); const read = tx.objectStore(store).get(key);
      read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error?.message); tx.oncomplete = () => db.close();
    };
  }), { store, key });
}
const state = () => readDatabase('state', 'current');
async function shot(name) { await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); }
async function waitReady() {
  await shareButton().waitFor(); await shareButton().evaluate(element => element.scrollIntoView({ block: 'nearest' }));
  await page.waitForFunction(() => { const element = document.querySelector('.check-in-share-primary'); return element && !element.disabled; });
  await share().locator('.check-in-share-preview > img').evaluate(image => image.decode());
}
async function currentScene() { return Number((await share().locator('.check-in-share-scenes small').innerText()).split('/')[0].trim()) - 1; }
async function selectScene(target) {
  for (let attempts = 0; await currentScene() !== target; attempts += 1) {
    assert.ok(attempts < 20);
    const current = await currentScene(); const forward = (target - current + 20) % 20; const backwards = (current - target + 20) % 20;
    await page.getByRole('button', { name: forward <= backwards ? '下一张风景' : '上一张风景', exact: true }).click();
    await waitReady();
  }
}
async function pngExport(saveName, { testNativeDownload = false } = {}) {
  await waitReady();
  const generated = await share().locator('.check-in-share-preview > img').evaluate(async image => {
    const response = await fetch(image.src); const blob = await response.blob();
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
    return { data, mime: blob.type, blobUrl: image.src };
  });
  assert.equal(generated.mime, 'image/png');
  const buffer = Buffer.from(generated.data.split(',')[1], 'base64');
  if (testNativeDownload) {
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存图片', exact: true }).click();
    const download = await downloadEvent; const failure = await download.failure();
    assert.equal(download.url(), generated.blobUrl, 'The real save action must target the exact PNG being previewed/decoded');
    report.nativeDownload = { status: failure ? 'blocked' : 'passed', failure, filename: download.suggestedFilename(), actualSaveActionInvoked: true, exactPreviewBlobPayload: true };
    if (!failure) {
      const saved = await readFile(await download.path()); assert.deepEqual(saved, buffer);
    } else {
      // Preserve this failed acceptance separately. Reading the live Blob for QR checks
      // does not establish that the browser successfully wrote a downloaded file.
      const diagnostics = await context.newPage();
      try {
        await diagnostics.goto('chrome://downloads/');
        report.nativeDownload.browserDiagnostics = await diagnostics.evaluate(() => document.querySelector('downloads-manager')?.items_?.map(item => ({ fileName: item.fileName, reason: item.lastReasonText, state: item.state, dangerous: item.isDangerous })));
      } catch (error) { report.nativeDownload.diagnosticsError = error.message; }
      finally { await diagnostics.close(); }
    }
    const item = { name: 'browser writes the actual PNG download to disk', status: report.nativeDownload.status, detail: report.nativeDownload };
    report.checks.push(item); console.log(JSON.stringify(item));
  }
  const png = pngjs.PNG.sync.read(buffer);
  assert.equal(png.width, 1080); assert.equal(png.height, 1584);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'dontInvert' });
  assert.equal(decoded?.data, HOME, 'Independent decoder must recover the exact public URL from the exported pixels');
  if (saveName) await writeFile(path.join(output, saveName), buffer);
  return { bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), source: 'actual Canvas PNG Blob; native disk save recorded separately', decoded: decoded.data, width: png.width, height: png.height };
}
async function openShare() {
  await page.getByRole('button', { name: /^(打卡并分享|分享打卡卡片)$/ }).click();
  await share().waitFor(); await waitReady();
}
async function buildPlanFixture() {
  const cached = await readDatabase('cache', 'study');
  assert.ok(cached?.manifest?.version && cached.text);
  const words = JSON.parse(cached.text);
  const { today, offset } = await page.evaluate(() => {
    const now = new Date(); const offset = now.getTimezoneOffset();
    return { today: new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10), offset };
  });
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const core = await vite.ssrLoadModule(path.join(root, 'packages/core/src/index.ts'));
    const yesterday = core.previousLocalDateKey(today);
    let previousTime = Date.now() - 86_400_000;
    let fixture = core.createInitialState(cached.manifest.version, previousTime++);
    fixture = core.updateSettings(fixture, { deck: 'ielts', groupSize: 30, autoSpeak: false }, previousTime++);
    // Actual engine operations produce the previous-day error set.
    for (let index = 0; index < 12; index += 1) {
      fixture = core.ensureSession(fixture, words, 'look', previousTime++, yesterday);
      fixture = core.answer(fixture, 'look', 'unknown', core.getCurrentToken(fixture, 'look'), previousTime++, yesterday);
      fixture = core.nextWord(fixture, 'look', core.getCurrentToken(fixture, 'look'), previousTime++);
    }
    let now = Date.now();
    const deadline = new Date(Date.parse(`${today}T00:00:00Z`) + 3659 * 86_400_000).toISOString().slice(0, 10);
    fixture = core.saveStudyPlan(fixture, words, { deck: 'ielts', mode: 'look', deadline }, now++, today);
    let summary;
    for (let index = 0; index < 250; index += 1) {
      summary = core.getStudyPlanSummary(fixture, words, 'ielts', 'look', today);
      if (summary.newCompleted >= 40 && summary.reviewCompleted === 12) break;
      fixture = core.ensureSession(fixture, words, 'look', now++, today);
      fixture = core.answer(fixture, 'look', 'known', core.getCurrentToken(fixture, 'look'), now++, today);
    }
    summary = core.getStudyPlanSummary(fixture, words, 'ielts', 'look', today);
    assert.equal(summary.newCompleted, 40); assert.equal(summary.reviewCompleted, 12); assert.equal(summary.canCheckIn, true);
    fixture = core.parseAppState(fixture, words, cached.manifest.version);
    await page.evaluate(value => new Promise((resolve, reject) => {
      const request = indexedDB.open('yanxai-word-v1'); request.onerror = () => reject(request.error?.message);
      request.onsuccess = () => {
        const db = request.result; const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(value, 'current');
        tx.oncomplete = () => { db.close(); resolve(true); }; tx.onabort = () => reject(tx.error?.message);
      };
    }), fixture);
    return { today, timezoneOffsetMinutes: offset, dictionaryVersion: cached.manifest.version, newWords: summary.newCompleted, reviewWords: summary.reviewCompleted, total: 52, revision: fixture.revision };
  } finally { await vite.close(); }
}
try {
  await page.goto(url);
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).click();
  await page.locator('.continue').waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await check('normal startup and PWA installation do not prefetch any share scene', async () => {
    assert.equal(report.imageRequests.length, 0); assert.equal(report.asrRequests.length, 0); assert.equal(report.audioRequests.length, 0);
    return { passiveSceneRequests: 0, passiveAsrRequests: 0, passiveAudioRequests: 0 };
  });
  const fixture = await buildPlanFixture(); report.planFixture = fixture;
  await page.reload(); await page.getByRole('button', { name: '打卡并分享', exact: true }).waitFor();
  const before = await state();
  await openShare();
  await check('real plan check-in opens the live lazy share UI and generates an independently decodable PNG', async () => {
    const after = await state();
    assert.deepEqual(after.modes, before.modes); assert.deepEqual(after.dailyActivity, before.dailyActivity); assert.deepEqual(after.history, before.history);
    assert.ok(after.studyPlans['ielts:look'].days[fixture.today].checkedInAt);
    assert.match(await share().locator('.check-in-share-preview img').getAttribute('alt'), /学习 52 词，新词 40，复习 12/);
    const image = await pngExport('first-export.png', { testNativeDownload: true }); assert.equal(report.nativeDownload.filename, `word-check-in-${fixture.today}.png`);
    report.capabilities = await page.evaluate(() => ({ secureContext: isSecureContext, nativeShare: typeof navigator.share, nativeCanShare: typeof navigator.canShare, nativePngCanShare: typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([new Uint8Array([137, 80, 78, 71])], 'capability.png', { type: 'image/png' })] }), barcodeDetector: typeof BarcodeDetector, clipboard: typeof navigator.clipboard?.writeText }));
    return { ...image, capabilities: report.capabilities };
  });
  const originalScene = await currentScene();
  const originalImage = await share().locator('.check-in-share-preview img').getAttribute('src');
  await check('offline unvisited scene fails honestly and preserves the previous usable scene and image', async () => {
    const nextScene = (originalScene + 1) % 20;
    const cached = await page.evaluate(async target => { for (const name of await caches.keys()) if (await (await caches.open(name)).match(new URL(target, location.href))) return true; return false; }, `images/check-in/${String(nextScene + 1).padStart(2, '0')}.png`);
    assert.equal(cached, false, 'This failure scenario must use a genuinely unvisited image');
    await context.setOffline(true);
    await page.getByRole('button', { name: '下一张风景', exact: true }).click();
    await share().getByRole('alert').waitFor(); await waitReady();
    assert.equal(await currentScene(), originalScene);
    assert.equal(await share().locator('.check-in-share-preview img').getAttribute('src'), originalImage);
    assert.match(await share().getByRole('alert').innerText(), /已保留/);
    return { requestedScene: nextScene + 1, retainedScene: originalScene + 1, genuineOffline: true, previouslyUncached: true };
  });
  await check('a previously viewed landscape and the share module regenerate an actual PNG after offline reload', async () => {
    await page.reload(); await page.getByRole('button', { name: '分享打卡卡片', exact: true }).waitFor(); await openShare();
    assert.equal(await currentScene(), originalScene);
    const image = await pngExport('offline-export.png');
    await context.setOffline(false);
    return { scene: originalScene + 1, ...image };
  });
  const exportsByScene = new Map();
  await check('all 20 real landscapes generate distinct PNG Blobs with the exact public QR', async () => {
    await selectScene(0);
    for (let scene = 0; scene < 20; scene += 1) {
      assert.equal(await currentScene(), scene);
      const image = await pngExport(scene === 0 ? 'coast-card.png' : scene === 19 ? 'scene-20-card.png' : undefined);
      exportsByScene.set(scene, image);
      console.log(JSON.stringify({ scene: scene + 1, pngBytes: image.bytes, qr: image.decoded }));
      if (scene < 19) { await page.getByRole('button', { name: '下一张风景', exact: true }).click(); await waitReady(); }
    }
    assert.equal(new Set([...exportsByScene.values()].map(image => image.sha256)).size, 20);
    report.scenes = [...exportsByScene].map(([scene, image]) => ({ scene: scene + 1, ...image }));
    return { scenes: 20, uniquePngs: 20, independentlyDecoded: 20 };
  });
  await check('rapid next/previous selection publishes only the final scene and prevents stale exports', async () => {
    await selectScene(0);
    await page.getByRole('button', { name: '下一张风景', exact: true }).click();
    await page.evaluate(() => { const button = document.querySelector('[aria-label="下一张风景"]'); button.click(); button.click(); document.querySelector('[aria-label="上一张风景"]').click(); });
    await waitReady(); assert.equal(await currentScene(), 2);
    const latest = await pngExport(); assert.equal(latest.sha256, exportsByScene.get(2).sha256);
    return { finalScene: 3, finalPngMatchesEarlierRealExport: true, intermediateSelectionsMayBeCoalesced: true };
  });
  await check('native sharing capability fallback is usable without pretending to send to WeChat or QQ', async () => {
    // Deliberate capability fault injection only. Canvas, File, app rendering and QR are real.
    // Actual native share was probed above; invoking an OS target is outside headless acceptance.
    await page.evaluate(() => { window.__checkInCanShare = navigator.canShare; Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }); });
    await shareButton().click(); await share().getByRole('status').filter({ hasText: '不支持图片分享' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存图片', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '复制官网链接', exact: true }).isEnabled(), true);
    await shot('unsupported-share-fallback');
    await page.evaluate(() => { Object.defineProperty(navigator, 'canShare', { configurable: true, value: window.__checkInCanShare }); delete window.__checkInCanShare; });
    return { capabilityFaultInjection: true, livePngUnaffected: true, nativeDeliveryNotClaimed: true };
  });
  await check('copy uses the actual browser clipboard and exposes selectable text when clipboard access fails', async () => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.getByRole('button', { name: '复制官网链接', exact: true }).click();
    await share().getByRole('status').filter({ hasText: '官网链接已复制' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), HOME);
    // Explicit failure injection for the denial branch; do not label this a real OS denial.
    await page.evaluate(() => { window.__checkInWriteText = navigator.clipboard.writeText; navigator.clipboard.writeText = async () => { throw new DOMException('Clipboard denial fixture', 'NotAllowedError'); }; });
    await page.getByRole('button', { name: '复制官网链接', exact: true }).click();
    const field = page.getByRole('textbox', { name: '官网地址', exact: true }); await field.waitFor(); assert.equal(await field.inputValue(), HOME);
    await page.getByRole('button', { name: '选中链接', exact: true }).click();
    assert.deepEqual(await field.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, HOME.length]);
    await shot('manual-copy-fallback');
    await page.evaluate(() => { navigator.clipboard.writeText = window.__checkInWriteText; delete window.__checkInWriteText; });
    return { realClipboardContents: HOME, denialBranchFaultInjected: true, fallbackSelectionLength: HOME.length };
  });
  await check('full-screen layout stays within desktop/mobile widths and actions remain reachable by scrolling', async () => {
    await selectScene(0); const layouts = [];
    for (const [name, width, height] of [['mobile-390', 390, 844], ['small-320', 320, 568], ['desktop', 1440, 1000]]) {
      await page.setViewportSize({ width, height }); await share().evaluate(element => { element.scrollTop = 0; }); await shot(`${name}-top`);
      const frame = await page.locator('.app-screen').boundingBox();
      const dialog = await page.getByRole('dialog', { name: '今日打卡', exact: true }).boundingBox();
      assert.ok(frame && dialog);
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(frame[key] - dialog[key]) <= 1, `Full-screen dialog ${key} must match the actual app frame, not float inside an old small modal`);
      const layout = await share().evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1); assert.ok(layout.documentWidth <= layout.viewportWidth + 1);
      const button = page.getByRole('button', { name: '保存图片', exact: true }); await button.scrollIntoViewIfNeeded(); const box = await button.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= height + 1, 'Saving must remain reachable inside the scrolling full-screen dialog');
      await shot(`${name}-actions`); layouts.push({ name, width, height, ...layout, appFrame: frame, dialogFrame: dialog, saveButton: box });
    }
    return layouts;
  });
  await check('closing sharing preserves study counts and makes no ASR/audio/third-party requests', async () => {
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await share().waitFor({ state: 'detached' });
    const after = await state(); assert.deepEqual(after.modes, before.modes); assert.deepEqual(after.dailyActivity, before.dailyActivity); assert.deepEqual(after.history, before.history);
    assert.equal(report.pageErrors.length, 0); assert.equal(report.thirdPartyRequests.length, 0); assert.equal(report.asrRequests.length, 0); assert.equal(report.audioRequests.length, 0);
    return { studyDataPreserved: true, thirdPartyRequests: 0, asrRequests: 0, hostedAudioRequests: 0, pageErrors: 0 };
  });
  report.status = report.nativeDownload?.status === 'passed' ? 'passed' : 'limited';
  if (report.status === 'limited') process.exitCode = 2;
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack };
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await context.close(); await browser.close();
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, output, failure: report.failure?.message }));
